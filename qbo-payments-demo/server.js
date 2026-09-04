// server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const qs = require('qs');
const bodyParser = require('body-parser');
const cookieSession = require('cookie-session');
const path = require('path');

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieSession({
  name: 'session',
  keys: [process.env.SESSION_SECRET || 'dev_secret'],
  maxAge: 24 * 60 * 60 * 1000
}));

const {
  INTUIT_CLIENT_ID,
  INTUIT_CLIENT_SECRET,
  INTUIT_REDIRECT_URI,
  INTUIT_AUTH_URL,
  INTUIT_TOKEN_URL,
  QBO_API_BASE,
  PAYMENTS_API_BASE
} = process.env;

// Serve demo client
app.use(express.static(path.join(__dirname, 'public')));

// 1) Start OAuth2 connect: redirect user to Intuit authorize screen
app.get('/auth/connect', (req, res) => {
  const state = Math.random().toString(36).substring(2); // simple CSRF guard
  req.session.state = state;

  const params = new URLSearchParams({
    client_id: INTUIT_CLIENT_ID,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting openid profile email address phone',
    redirect_uri: INTUIT_REDIRECT_URI,
    state
  });

  res.redirect(`${INTUIT_AUTH_URL}?${params.toString()}`);
});

// 2) OAuth callback: exchange code for access + refresh tokens
app.get('/auth/callback', async (req, res) => {
  const { code, state, realmId } = req.query;
  if (!code || state !== req.session.state) {
    return res.status(400).send('Missing code or state mismatch');
  }

  try {
    const tokenResponse = await axios.post(INTUIT_TOKEN_URL, qs.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: INTUIT_REDIRECT_URI
    }), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      auth: {
        username: INTUIT_CLIENT_ID,
        password: INTUIT_CLIENT_SECRET
      }
    });

    // tokenResponse.data contains access_token, refresh_token, expires_in, id_token
    req.session.tokens = tokenResponse.data;
    // realmId is the company id (QBO) returned by the connect flow
    req.session.realmId = realmId;

    res.send(`<h3>Connected!</h3>
      <p>realmId: ${realmId}</p>
      <p>Access token stored in session (sandbox only). Close this and return to the demo page.</p>
      <p><a href="/">Back to demo</a></p>`);
  } catch (err) {
    console.error('Token exchange error', err.response ? err.response.data : err.message);
    res.status(500).send('Token exchange failed: ' + (err.response ? JSON.stringify(err.response.data) : err.message));
  }
});

// 3) Create one-time payment (sandbox demo)
// Accepts either:
//  - { card: { number, expMonth, expYear, cvc }, amount, currency, customer }  // TEST only
//  OR
//  - { paymentToken, amount, currency, customer } // production: token from client-side SDK
app.post('/create-payment', async (req, res) => {
  const tokens = req.session.tokens;
  if (!tokens || !req.session.realmId) {
    return res.status(401).json({ error: 'Not connected to QuickBooks. Please /auth/connect first.' });
  }

  const accessToken = tokens.access_token;
  const realmId = req.session.realmId;

  const { paymentToken, card, amount, currency = 'USD', customer } = req.body;
  if (!amount) return res.status(400).json({ error: 'amount is required (in smallest currency unit e.g. cents)' });

  try {
    // NOTE: Replace path and payload below with the exact Payments API shape from the Intuit docs.
    // Using a placeholder POST to Payments API base. In sandbox you can test with raw card fields,
    // but in production you should use Intuit's client-side tokenization / hosted fields.
    const paymentsPayload = paymentToken ? {
      // tokenized payment path
      token: paymentToken,
      amount: amount,
      currency: currency,
      context: { customer }
    } : {
      // Test-only raw-card payload: DO NOT USE IN PRODUCTION
      card: {
        number: card.number,
        expMonth: card.expMonth,
        expYear: card.expYear,
        cvc: card.cvc
      },
      amount,
      currency,
      context: { customer }
    };

    // Example endpoint — confirm exact path with Intuit docs (this is a common pattern):
    const paymentsUrl = `${PAYMENTS_API_BASE}/charges`; // <<-- verify in docs

    const paymentResp = await axios.post(paymentsUrl, paymentsPayload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    // paymentResp.data contains gateway response; example structure varies by API version
    const paymentResult = paymentResp.data;

    // Optional: Create a record in QuickBooks Online (SalesReceipt or Payment)
    // Example: POST /v3/company/{realmId}/salesreceipt or /payment
    // You must adapt the body to the QBO API schema. Below is a minimal example to create a SalesReceipt.
    try {
      const qboUrl = `${QBO_API_BASE}/${realmId}/salesreceipt?minorversion=65`; // minorversion optional
      const salesReceiptBody = {
        // Minimal fields — customize to your needs
        CustomerRef: { value: (customer && customer.id) ? String(customer.id) : '1', name: (customer && customer.name) ? customer.name : 'Guest' },
        TotalAmt: (amount / 100), // QBO expects decimal dollars
        PrivateNote: `Payment via QuickBooks Payments — gateway id: ${paymentResult.id || paymentResult.gatewayTransactionId || 'N/A'}`,
        // Add Line items if you want to itemize; needed in many QBO setups
        Line: [
          {
            Amount: (amount / 100),
            DetailType: "SalesItemLineDetail",
            SalesItemLineDetail: { ItemRef: { value: "1", name: "Services" } }
          }
        ]
      };

      const qboResp = await axios.post(qboUrl, salesReceiptBody, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });

      return res.json({
        paymentResult,
        qboRecord: qboResp.data
      });
    } catch (qboErr) {
      // If QBO record creation fails, return payment result but warn
      console.error('QBO create error', qboErr.response ? qboErr.response.data : qboErr.message);
      return res.status(200).json({
        paymentResult,
        qboError: qboErr.response ? qboErr.response.data : qboErr.message
      });
    }

  } catch (err) {
    console.error('Payment error', err.response ? err.response.data : err.message);
    return res.status(500).json({ error: 'Payment failed', details: err.response ? err.response.data : err.message });
  }
});

// 4) Webhook endpoint placeholder for payment events (signature verification required in production)
app.post('/webhook', (req, res) => {
  // Intuit sends webhooks for payments and QBO events. Verify signature header against your webhook secret.
  console.log('Webhook received:', req.headers, req.body);
  res.status(200).send('ok');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
