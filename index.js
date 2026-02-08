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

// --- FIREBASE ADMIN SETUP ---
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
        return res.status(401).send({ message: 'unauthorized access' });
    }
    const token = authHeader.split(' ')[1];
    jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
        if (err) {
            return res.status(401).send({ message: 'unauthorized access' });
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
            const user = req.body;
            const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '1h' });
            res.send({ token });
        });

        // --- USER STATS API (Fixes 404 Error) ---
        app.get('/user-stats/:email', verifyToken, async (req, res) => {
            const email = req.params.email;
            if (email !== req.decoded.email) {
                return res.status(403).send({ message: 'forbidden access' });
            }
            // প্রোফাইলের জন্য প্রয়োজনীয় স্ট্যাটাস হিসেব করা
            const myTuitionsCount = await tutionsCollection.countDocuments({ studentEmail: email });
            const myApplicationsCount = await appicationsCollection.countDocuments({ tutorEmail: email });
            const myPayments = await paymentsCollection.find({ email: email }).toArray();
            
            res.send({
                tuitions: myTuitionsCount,
                applications: myApplicationsCount,
                totalPaid: myPayments.length
            });
        });

        // --- USERS & ROLE API ---
        app.get('/users/role/:email', async (req, res) => {
            const email = req.params.email;
            if (email === "admin@etuition.com") return res.send({ role: "admin" });
            const user = await usersCollectin.findOne({ email: email });
            res.send({ role: user?.role || 'student' });
        });

        app.post('/users', async (req, res) => {
            const newUser = req.body;
            const query = { email: newUser.email };
            const existingUser = await usersCollectin.findOne(query);
            if (existingUser) return res.send({ message: 'user already exists', insertedId: null });
            const result = await usersCollectin.insertOne(newUser);
            res.send(result);
        });

        // --- APPLICATIONS / HIRING REQUESTS (Protected) ---
        app.get('/hiring-requests/:email', verifyToken, async (req, res) => {
            const email = req.params.email;
            if (email !== req.decoded.email) {
                return res.status(403).send({ message: 'forbidden access' });
            }
            const result = await appicationsCollection.find({ tutorEmail: email }).sort({ appliedDate: -1 }).toArray();
            res.send(result);
        });

        app.get('/hiring-requests-by-student/:email', verifyToken, async (req, res) => {
            const email = req.params.email;
            if (email !== req.decoded.email) {
                return res.status(403).send({ message: 'forbidden access' });
            }
            const result = await appicationsCollection.find({ studentEmail: email }).sort({ appliedDate: -1 }).toArray();
            res.send(result);
        });

        // --- TUITIONS API ---
        app.get('/tuitions', async (req, res) => {
            const email = req.query.email;
            let query = email ? { studentEmail: email } : {};
            const result = await tutionsCollection.find(query).sort({ postedDate: -1 }).toArray();
            res.send(result);
        });

        app.post('/tuitions', verifyToken, async (req, res) => {
            const result = await tutionsCollection.insertOne(req.body);
            res.send(result);
        });

        // --- STRIPE & PAYMENTS ---
        app.post("/create-payment-intent", verifyToken, async (req, res) => {
            const { salary } = req.body;
            const amount = Math.round(parseFloat(salary) * 100);
            if (!amount || amount < 1) return res.status(400).send({ message: "Invalid amount" });

            const paymentIntent = await stripe.paymentIntents.create({
                amount: amount,
                currency: "usd",
                payment_method_types: ["card"],
            });
            res.send({ clientSecret: paymentIntent.client_secret });
        });

        app.post("/payments", verifyToken, async (req, res) => {
            const payment = req.body;
            const paymentResult = await paymentsCollection.insertOne(payment);
            const query = { _id: new ObjectId(payment.appId) };
            const updateDoc = { $set: { status: "paid" } };
            const updateResult = await appicationsCollection.updateOne(query, updateDoc);
            res.send({ paymentResult, updateResult });
        });

        console.log("🚀 MongoDB Connected & Routes Secured");
    } finally { }
}
run().catch(console.dir);

app.get('/', (req, res) => res.send("eTuition Server Running"));
app.listen(port, () => console.log(`Server port: ${port}`));