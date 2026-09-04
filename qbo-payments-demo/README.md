# QuickBooks Payments Demo (Node/Express)

This folder contains a sandbox/demo implementation showing a one-time card charge flow with QuickBooks Payments and an optional SalesReceipt creation in QuickBooks Online (QBO).

Files added:
- .env.example - example env variables (placeholders only)
- package.json
- server.js - Express server with OAuth connect, token exchange, create-payment endpoint, and webhook placeholder
- public/index.html - sandbox demo client (sends raw card data to the server for testing only)

Important: DO NOT USE raw card collection in production. Use Intuit's client-side tokenization / hosted fields to avoid handling raw card data and to reduce PCI scope.

Quick start:
1. Copy qbo-payments-demo/.env.example to qbo-payments-demo/.env and fill in your Intuit app credentials.
2. cd qbo-payments-demo && npm install
3. npm start
4. Open http://localhost:3000, connect a sandbox QuickBooks company, then use the demo form to create a test charge.

Security notes:
- The commit contains placeholders only. Never commit real secrets.
- Rotate any leaked keys and use a secrets manager for production.

See the included server.js for implementation details and comments.
