require("dotenv").config();
const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

// Use `let` instead of `const` for ZOHO_ACCESS_TOKEN
let ZOHO_ACCESS_TOKEN = process.env.ZOHO_ACCESS_TOKEN;
const { ZOHO_REFRESH_TOKEN, ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_ORGANIZATION_ID, PORT = 3000 } = process.env;

// Function to refresh Zoho token
async function refreshZohoToken() {
    try {
        const response = await axios.post("https://accounts.zoho.com/oauth/v2/token", null, {
            params: { refresh_token: ZOHO_REFRESH_TOKEN, client_id: ZOHO_CLIENT_ID, client_secret: ZOHO_CLIENT_SECRET, grant_type: "refresh_token" }
        });
        ZOHO_ACCESS_TOKEN = response.data.access_token; // This is now allowed since ZOHO_ACCESS_TOKEN is `let`
        console.log("Zoho Access Token Refreshed:", ZOHO_ACCESS_TOKEN);
    } catch (error) {
        console.error("Failed to refresh Zoho token:", error.response?.data || error.message);
        throw new Error("Failed to refresh Zoho token");
    }
}

// Function to make API requests with token expiration handling
async function makeZohoRequest(config, retry = true) {
    try {
        config.headers = { ...config.headers, Authorization: `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}` };
        const response = await axios(config);
        return response.data;
    } catch (error) {
        if ((error.response?.status === 401 || error.response?.data?.code === 57) && retry) {
            console.log("Access token expired or invalid. Refreshing token and retrying request...");
            await refreshZohoToken();
            return makeZohoRequest(config, false); // Retry the request once with the new token
        } else {
            console.error("API request failed:", error.response ? error.response.data : error.message);
            throw new Error("API request failed");
        }
    }
}

// Function to find an existing invoice by transaction ID
async function findExistingInvoice(transactionId) {
    const response = await makeZohoRequest({
        method: "get",
        url: `https://www.zohoapis.com/books/v3/invoices?organization_id=${ZOHO_ORGANIZATION_ID}&reference_number=${transactionId}`
    });
    return response.invoices.find(invoice => invoice.reference_number === transactionId) || null;
}

// Function to update an invoice with discount (if applicable)
async function updateInvoice(invoiceId, transaction) {
    try {
        const discountAmount = parseFloat(transaction["Discount"]) || 0;
        const lineItems = (transaction["Services (link)"] || []).map((service, index) => ({
            description: service.value || "Service",
            rate: parseFloat(transaction["Prices"][index]?.value) || 0,
            quantity: 1
        }));

        const invoiceData = {
            line_items: lineItems,
            total: parseFloat(transaction["Payable Amount"]) || 0,
            discount: discountAmount,
            discount_type: "entity_level", // Apply discount at the invoice level
            is_discount_before_tax: true, // Apply discount before tax
            reason: "Updating invoice due to payment adjustment" // Mandatory reason for updating a sent invoice
        };

        const response = await makeZohoRequest({
            method: "put",
            url: `https://www.zohoapis.com/books/v3/invoices/${invoiceId}?organization_id=${ZOHO_ORGANIZATION_ID}`,
            data: invoiceData
        });
        return response.invoice;
    } catch (error) {
        console.error("Error updating invoice:", error.message);
        throw new Error("Failed to update invoice");
    }
}

// Function to create a payment
async function createPayment(invoiceId, amount, transactionId, transaction) {
    try {
        const invoiceResponse = await makeZohoRequest({
            method: "get",
            url: `https://www.zohoapis.com/books/v3/invoices/${invoiceId}?organization_id=${ZOHO_ORGANIZATION_ID}`
        });
        const { customer_id: customerId, balance: invoiceBalance } = invoiceResponse.invoice;

        if (amount > invoiceBalance) {
            await createCreditNote(customerId, amount - invoiceBalance, transactionId, transaction);
            throw new Error("Payment amount exceeds the invoice balance. Credit note created.");
        }

        const paymentData = {
            customer_id: customerId,
            payment_mode: determinePaymentMode(transaction),
            amount: Math.min(amount, invoiceBalance),
            date: new Date().toISOString().split("T")[0],
            reference_number: transactionId,
            invoices: [{ invoice_id: invoiceId, amount_applied: Math.min(amount, invoiceBalance) }]
        };

        const paymentResponse = await makeZohoRequest({
            method: "post",
            url: `https://www.zohoapis.com/books/v3/customerpayments?organization_id=${ZOHO_ORGANIZATION_ID}`,
            data: paymentData
        });
        return paymentResponse;
    } catch (error) {
        console.error("Error creating payment:", error.message);
        throw new Error("Failed to create payment");
    }
}

// Function to create a credit note
async function createCreditNote(customerId, amount, transactionId, transaction) {
    const creditNoteData = {
        customer_id: customerId,
        date: new Date().toISOString().split("T")[0],
        line_items: [{
            description: "Credit for overpayment",
            rate: amount,
            quantity: 1
        }],
        creditnote_number: `CN-${transactionId}`,
        reference_number: transactionId
    };

    return makeZohoRequest({
        method: "post",
        url: `https://www.zohoapis.com/books/v3/creditnotes?organization_id=${ZOHO_ORGANIZATION_ID}`,
        data: creditNoteData
    });
}

// Function to determine the payment mode
function determinePaymentMode(transaction) {
    if (transaction["Amount Paid (Cash)"] > 0) return "Cash";
    if (transaction["Bank Transfer"] > 0) return "Bank Transfer";
    if (transaction["Cheque"] > 0) return "Check";
    if (transaction["POS"] > 0) return "POS";
    return "Cash";
}

// Webhook endpoint
app.post("/webhook", async (req, res) => {
    try {
        const transaction = req.body.items[0];
        const transactionId = transaction["Transaction ID"];
        const existingInvoice = await findExistingInvoice(transactionId);

        if (!existingInvoice) {
            return res.status(200).json({ message: "No existing invoice found. Script stopped." });
        }

        // Step 1: Update the invoice with discount (if applicable)
        await updateInvoice(existingInvoice.invoice_id, transaction);

        // Step 2: Check if "Total Amount Paid" is greater than 0
        const totalAmountPaid = parseFloat(transaction["Total Amount Paid"]) || 0;
        if (totalAmountPaid > 0) {
            // Step 3: Create a new payment for the invoice
            await createPayment(existingInvoice.invoice_id, totalAmountPaid, transactionId, transaction);
        }

        res.status(200).json({ message: "Invoice and payment processed successfully." });
    } catch (error) {
        if (error.message === "Payment amount exceeds the invoice balance. Credit note created.") {
            res.status(200).json({ message: error.message });
        } else {
            res.status(500).json({ message: "Error processing webhook", error: error.message });
        }
    }
});

// Start the server
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
