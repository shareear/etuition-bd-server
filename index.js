const express = require('express');
const admin = require("firebase-admin");
const cors = require('cors');
const jwt = require('jsonwebtoken');
const port = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(cors());
app.use(express.json());

// --- FIREBASE ADMIN SETUP (With Error Handling) ---
try {
    const decoded = Buffer.from(process.env.FIREBASE_SERVICE_KEY, "base64").toString("utf-8");
    const serviceAccount = JSON.parse(decoded);
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    }
    console.log("✅ Firebase Admin Initialized");
} catch (error) {
    console.error("❌ Firebase Admin Init Error:", error.message);
}

// --- JWT VERIFICATION MIDDLEWARE ---
const verifyToken = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).send({ message: 'Unauthorized access: No token provided' });
    }
    const token = authHeader.split(' ')[1];
    jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
        if (err) {
            return res.status(401).send({ message: 'Unauthorized access: Invalid token' });
        }
        req.decoded = decoded;
        next();
    });
};

// MONGO Connection
const uri = process.env.MONGO_URI;
const client = new MongoClient(uri, {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
});

async function run() {
    try {
        await client.connect();
        const db = client.db("etuitionBD");
        const tutionsCollection = db.collection("tuitions");
        const usersCollectin = db.collection("users");
        const appicationsCollection = db.collection("applications");
        const paymentsCollection = db.collection("payments");

        // --- AUTH/JWT API ---
        app.post('/jwt', async (req, res) => {
            try {
                const user = req.body;
                if (!user.email) return res.status(400).send({ message: "Email required" });
                
                const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '1h' });
                res.send({ token });
            } catch (error) {
                res.status(500).send({ message: "JWT generation failed" });
            }
        });

        // --- USERS API ---
        app.get('/users/role/:email', async (req, res) => {
            const email = req.params.email;
            if (email === "admin@etuition.com") return res.send({ role: "admin" });
            const user = await usersCollectin.findOne({ email: email });
            res.send({ role: user?.role || 'student' });
        });

        app.post('/users', async (req, res) => {
            const newUser = req.body;
            const existingUser = await usersCollectin.findOne({ email: newUser.email });
            if (existingUser) return res.send({ message: 'User exists' });
            const result = await usersCollectin.insertOne(newUser);
            res.send(result);
        });

        // --- PROTECTED DASHBOARD DATA (Sensitive) ---
        app.get('/hiring-requests/:email', verifyToken, async (req, res) => {
            // সিকিউরিটি চেক: ইমেইল ম্যাচ করে কি না
            if (req.params.email !== req.decoded.email) {
                return res.status(403).send({ message: 'Forbidden access' });
            }
            const result = await appicationsCollection.find({ tutorEmail: req.params.email }).sort({ appliedDate: -1 }).toArray();
            res.send(result);
        });

        app.get('/hiring-requests-by-student/:email', verifyToken, async (req, res) => {
            if (req.params.email !== req.decoded.email) {
                return res.status(403).send({ message: 'Forbidden access' });
            }
            const result = await appicationsCollection.find({ studentEmail: req.params.email }).sort({ appliedDate: -1 }).toArray();
            res.send(result);
        });

        // --- STRIPE PAYMENT INTENT ---
        app.post("/create-payment-intent", verifyToken, async (req, res) => {
            const { salary } = req.body;
            if (!salary || isNaN(parseFloat(salary))) return res.status(400).send({ message: "Invalid Salary" });

            const amount = Math.round(parseFloat(salary) * 100);
            try {
                const paymentIntent = await stripe.paymentIntents.create({
                    amount: amount,
                    currency: "usd",
                    payment_method_types: ["card"],
                });
                res.send({ clientSecret: paymentIntent.client_secret });
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // --- REMAINING APIS (Simplified for brevity but protected) ---
        app.post("/payments", verifyToken, async (req, res) => {
            const payment = req.body;
            const paymentResult = await paymentsCollection.insertOne(payment);
            const updateResult = await appicationsCollection.updateOne(
                { _id: new ObjectId(payment.appId) },
                { $set: { status: "paid" } }
            );
            res.send({ paymentResult, updateResult });
        });

        console.log("🚀 Server Connected to MongoDB");
    } finally { }
}
run().catch(console.dir);

app.get('/', (req, res) => res.send("eTuition Server Running"));
app.listen(port, () => console.log(`Server port: ${port}`));