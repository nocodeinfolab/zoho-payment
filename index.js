require("dotenv").config();
const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

const { ZOHO_ACCESS_TOKEN, ZOHO_REFRESH_TOKEN, ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_ORGANIZATION_ID, PORT = 3000 } = process.env;

async function refreshZohoToken() {
    try {
        const response = await axios.post("https://accounts.zoho.com/oauth/v2/token", null, {
            params: { refresh_token: ZOHO_REFRESH_TOKEN, client_id: ZOHO_CLIENT_ID, client_secret: ZOHO_CLIENT_SECRET, grant_type: "refresh_token" }
        });
        ZOHO_ACCESS_TOKEN = response.data.access_token;
    } catch (error) {
        console.error("Failed to refresh Zoho token:", error.response?.data || error.message);
        throw new Error("Failed to refresh Zoho token");
    }
}

async function makeZohoRequest(config, retry = true) {
    try {
        config.headers = { ...config.headers, Authorization: `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}` };
        const response = await axios(config);
        return response.data;
    } catch (error) {
        if ((error.response?.status === 401 || error.response?.data?.code === 57) && retry) {
            await refreshZohoToken();
            return makeZohoRequest(config, false);
        }
        throw new Error("API request failed");
    }
}

async function findExistingInvoice(transactionId) {
    const response = await makeZohoRequest({
        method: "get",
        url: `https://www.zohoapis.com/books/v3/invoices?organization_id=${ZOHO_ORGANIZATION_ID}&reference_number=${transactionId}`
    });
    return response.invoices.find(invoice => invoice.reference_number === transactionId) || null;
}

async function createPayment(invoiceId, amount, transactionId, transaction) {
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

    return makeZohoRequest({
        method: "post",
        url: `https://www.zohoapis.com/books/v3/customerpayments?organization_id=${ZOHO_ORGANIZATION_ID}`,
        data: paymentData
    });
}

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

function determinePaymentMode(transaction) {
    if (transaction["Amount Paid (Cash)"] > 0) return "Cash";
    if (transaction["Bank Transfer"] > 0) return "Bank Transfer";
    if (transaction["Cheque"] > 0) return "Check";
    if (transaction["POS"] > 0) return "POS";
    return "Cash";
}

app.post("/webhook", async (req, res) => {
    try {
        const transaction = req.body.items[0];
        const transactionId = transaction["Transaction ID"];
        const existingInvoice = await findExistingInvoice(transactionId);

        if (!existingInvoice) return res.status(200).json({ message: "No existing invoice found. Script stopped." });

        const totalAmountPaid = parseFloat(transaction["Total Amount Paid"]) || 0;
        if (totalAmountPaid > 0) {
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

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
