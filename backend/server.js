const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
const port = process.env.PORT || 3000;

// Fix private key formatting from .env
const privateKey = process.env.FIREBASE_PRIVATE_KEY 
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') 
    : undefined;

// Initialize Firebase
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: privateKey,
        })
    });
}

const db = admin.firestore();
const startupTime = new Date();

const sendNotification = async (title, message) => {
    try {
        const response = await axios.post(
            'https://onesignal.com/api/v1/notifications',
            {
                app_id: process.env.ONESIGNAL_APP_ID,
                // Server directly targets your Email
                filters: [
                    {"field": "tag", "key": "email", "relation": "=", "value": process.env.ADMIN_EMAIL}
                ],
                headings: { en: title },
                contents: { en: message }
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Basic ${process.env.ONESIGNAL_REST_API_KEY}`
                }
            }
        );
        console.log("Notification sent successfully!");
    } catch (error) {
        console.error("Error sending notification:", error.response ? error.response.data : error.message);
    }
};

// Listen to Transactions (Deposits / Withdrawals)
db.collection('transactions').where('status', '==', 'Pending')
    .onSnapshot((snapshot) => {
        snapshot.docChanges().forEach((change) => {
            if (change.type === 'added') {
                const data = change.doc.data();
                const createdAt = data.createdAt ? data.createdAt.toDate() : new Date();
                
                if (createdAt >= startupTime) {
                    if (data.type === 'Recharge') {
                        sendNotification('New Deposit Request', `User requested a deposit of ${data.amount} USDT.`);
                    } else if (data.type === 'Withdrawal') {
                        sendNotification('New Withdrawal Request', `User requested a withdrawal of ${data.amount} USDT.`);
                    }
                }
            }
        });
    });

// Listen to Support Tickets
db.collection('tickets').where('status', '==', 'Pending')
    .onSnapshot((snapshot) => {
        snapshot.docChanges().forEach((change) => {
            if (change.type === 'added') {
                const data = change.doc.data();
                const createdAt = data.createdAt ? data.createdAt.toDate() : new Date();
                
                if (createdAt >= startupTime) {
                    sendNotification('New Support Ticket', `A user just sent a message.`);
                }
            }
        });
    });

// Keep-alive route
app.get('/', (req, res) => {
    res.send('Notification Server is Active! 🟢');
});

const BINANCE_PAY_URL = 'https://bpay.binanceapi.com/binancepay/openapi/v2/order';

app.post('/api/payment/binance/create-order', async (req, res) => {
    const { amount, userId, userEmail } = req.body;

    if (!amount || !userId) {
        return res.status(400).json({ error: 'Amount and User ID are required' });
    }

    try {
        const secretsRef = db.collection('settings').doc('secrets');
        const generalRef = db.collection('settings').doc('general');
        
        const [secretsSnap, generalSnap] = await Promise.all([secretsRef.get(), generalRef.get()]);
        
        if (!secretsSnap.exists || !generalSnap.exists) {
            return res.status(500).json({ error: 'Payment gateway not configured' });
        }

        const secrets = secretsSnap.data();
        const general = generalSnap.data();

        const apiKey = secrets.binanceApiKey;
        const apiSecret = secrets.binanceApiSecret;
        const merchantId = general.binanceMerchantId;

        if (!apiKey || !apiSecret || !merchantId) {
            return res.status(500).json({ error: 'Binance Pay credentials missing' });
        }

        const nonce = crypto.randomBytes(16).toString('hex').toUpperCase();
        const timestamp = Date.now();
        
        const body = {
            env: { terminalType: "WEB" },
            merchantTradeNo: `TX${Date.now()}${Math.floor(Math.random() * 1000)}`,
            orderAmount: parseFloat(amount).toFixed(2),
            currency: "USDT",
            goods: {
                goodsType: "01",
                goodsCategory: "Z000",
                referenceGoodsId: "recharge",
                goodsName: "Wallet Recharge",
                goodsDetail: `Recharge for user ${userEmail || userId}`
            },
            // We'll use a generic return URL, the user can navigate back
            checkoutUrl: req.headers.origin || "https://your-site.com",
            cancelUrl: req.headers.origin || "https://your-site.com"
        };

        const bodyString = JSON.stringify(body);
        const payload = timestamp + "\n" + nonce + "\n" + bodyString + "\n";
        const signature = crypto.createHmac('sha512', apiSecret).update(payload).digest('hex').toUpperCase();

        const response = await axios.post(BINANCE_PAY_URL, body, {
            headers: {
                'Content-Type': 'application/json',
                'BinancePay-Timestamp': timestamp,
                'BinancePay-Nonce': nonce,
                'BinancePay-Certificate-SN': apiKey,
                'BinancePay-Signature': signature
            }
        });

        if (response.data.status === 'SUCCESS') {
            res.json(response.data.data);
        } else {
            console.error("Binance API Error:", response.data);
            res.status(400).json({ error: response.data.errorMessage || 'Binance Pay Error' });
        }

    } catch (error) {
        console.error("Binance Order Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Failed to create Binance order' });
    }
});

app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});
