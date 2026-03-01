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
        const tutionsCollection = db.collection("tution");
        const usersCollectin = db.collection("users");
        const appicationsCollection = db.collection("applications");
        const paymentsCollection = db.collection("payments");

        // --- AUTH/JWT API ---
        app.post('/jwt', async (req, res) => {
            const user = req.body;
            const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '1h' });
            res.send({ token });
        });

        // --- CONSOLIDATED USER STATS & PUBLIC PROFILE API ---
        app.get('/user-stats/:email', async (req, res) => {
            try {
                const email = req.params.email;
                const authHeader = req.headers.authorization;
                const user = await usersCollectin.findOne({ email: email });
                if (!user) return res.status(404).send({ message: 'User not found' });

                const publicProfile = {
                    name: user.name, email: user.email, image: user.image || user.photoURL,
                    role: user.role, phone: user.phone, address: user.address,
                    institution: user.institution, class: user.class, gender: user.gender
                };

                if (!authHeader) return res.send({ user: publicProfile });

                const token = authHeader.split(' ')[1];
                jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, async (err, decoded) => {
                    if (err || email !== decoded.email) return res.send({ user: publicProfile });
                    let stats = {};
                    if (user?.role === 'admin') {
                        const totalUsers = await usersCollectin.countDocuments();
                        const totaltution = await tutionsCollection.countDocuments();
                        const allPayments = await paymentsCollection.find().toArray();
                        const earnings = allPayments.reduce((sum, payment) => sum + parseFloat(payment.salary || 0), 0);
                        stats = { totalUsers, totaltution, earnings };
                    } else if (user?.role === 'tutor') {
                        const applications = await appicationsCollection.countDocuments({ tutorEmail: email });
                        const ongoingtution = await appicationsCollection.countDocuments({ tutorEmail: email, status: 'paid' });
                        const tutorPayments = await paymentsCollection.find({ tutorEmail: email }).toArray();
                        const totalEarnings = tutorPayments.reduce((sum, p) => sum + parseFloat(p.salary || 0), 0);
                        stats = { applications, ongoingtution, totalEarnings };
                    } else {
                        const tution = await tutionsCollection.countDocuments({ studentEmail: email });
                        const totalPaid = await paymentsCollection.countDocuments({ studentEmail: email });
                        stats = { tution, totalPaid };
                    }
                    res.send({ user: publicProfile, stats });
                });
            } catch (error) { res.status(500).send({ message: "Internal Server Error" }); }
        });

        // --- USERS & ROLE API ---
        app.get('/users', async (req, res) => {
            const result = await usersCollectin.find().toArray();
            res.send(result);
        });

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
            if (existingUser) return res.send({ message: 'user already exists', insertedId: existingUser._id });
            const result = await usersCollectin.insertOne(newUser);
            res.send(result);
        });

        // --- ADMIN: MANAGE tution ---
        app.get('/admin/pending-tution', verifyToken, async (req, res) => {
            const query = { status: 'pending' };
            const result = await tutionsCollection.find(query).toArray();
            res.send(result);
        });

        app.patch('/tution/status/:id', verifyToken, async (req, res) => {
            const id = req.params.id;
            const status = req.body.status;
            const filter = { _id: new ObjectId(id) };
            const updateDoc = { $set: { status: status } };
            const result = await tutionsCollection.updateOne(filter, updateDoc);
            res.send(result);
        });

        // --- ADMIN: ANALYTICS API (RESTORED) ---
        app.get('/admin/analytics', verifyToken, async (req, res) => {
            const totalUsers = await usersCollectin.countDocuments();
            const payments = await paymentsCollection.find().toArray();
            const totalVolume = payments.reduce((sum, p) => sum + parseFloat(p.salary || 0), 0);
            const platformRevenue = totalVolume * 0.20; 
            res.send({ totalUsers, totalVolume, platformRevenue, payments });
        });

        // --- RESTORED APPLICATIONS COLLECTION APIS ---
        app.post('/hiring-requests', verifyToken, async (req, res) => {
            const result = await appicationsCollection.insertOne(req.body);
            res.send(result);
        });

        app.get('/hiring-requests-by-tutor/:email', verifyToken, async (req, res) => {
            const email = req.params.email;
            if (email !== req.decoded.email) return res.status(403).send({ message: 'forbidden' });
            const result = await appicationsCollection.find({ tutorEmail: email }).toArray();
            res.send(result);
        });

        app.get('/hiring-requests-by-student/:email', async (req, res) => {
            const result = await appicationsCollection.find({ studentEmail: req.params.email }).toArray();
            res.send(result);
        });

        app.patch('/applications/status/:id', verifyToken, async (req, res) => {
            const result = await appicationsCollection.updateOne(
                { _id: new ObjectId(req.params.id) },
                { $set: { status: req.body.status } }
            );
            res.send(result);
        });

        app.delete('/applications/:id', verifyToken, async (req, res) => {
            const result = await appicationsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
            res.send(result);
        });

        app.get('/ongoing-tution/:email', verifyToken, async (req, res) => {
            const email = req.params.email;
            const role = req.query.role;
            if (email !== req.decoded.email) return res.status(403).send({ message: 'forbidden' });
            let query = { status: 'paid' };
            role === 'tutor' ? query.tutorEmail = email : query.studentEmail = email;
            const result = await appicationsCollection.find(query).toArray();
            res.send(result);
        });

        app.delete('/terminate-contract/:id', verifyToken, async (req, res) => {
            const id = req.params.id;
            const { tutorEmail, studentEmail, subject } = req.body;
            const deleteResult = await appicationsCollection.deleteOne({ _id: new ObjectId(id) });
            if (deleteResult.deletedCount > 0) {
                await db.collection("notifications").insertOne({
                    receiverEmail: tutorEmail, senderEmail: studentEmail,
                    message: `Contract for ${subject} was terminated by the student.`,
                    type: 'termination', date: new Date()
                });
            }
            res.send(deleteResult);
        });

        // --- tution CORE API ---
        app.get('/tution', async (req, res) => {
            const email = req.query.email;
            let query = email ? { studentEmail: email } : { status: 'approved' };
            const result = await tutionsCollection.find(query).sort({ postedDate: -1 }).toArray();
            res.send(result);
        });

        app.get('/tution/:id', async (req, res) => {
            try {
                const id = req.params.id;
                const result = await tutionsCollection.findOne({ _id: new ObjectId(id) });
                if (!result) {
                    return res.status(404).send({ message: "Tuition not found" });
                }
                res.send(result);
            } catch (error) {
                res.status(500).send({ message: "Internal Server Error" });
            }
        });

        app.post('/tution', verifyToken, async (req, res) => {
            const result = await tutionsCollection.insertOne(req.body);
            res.send(result);
        });

        app.patch('/tution/:id', verifyToken, async (req, res) => {
            const updatedDoc = { $set: { 
                subject: req.body.subject, class: req.body.class, 
                salary: parseFloat(req.body.salary), location: req.body.location 
            }};
            const result = await tutionsCollection.updateOne({ _id: new ObjectId(req.params.id) }, updatedDoc);
            res.send(result);
        });

        app.delete('/tution/:id', verifyToken, async (req, res) => {
            const result = await tutionsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
            res.send(result);
        });

        // --- STRIPE & PAYMENTS ---
        app.post("/create-payment-intent", verifyToken, async (req, res) => {
            const amount = Math.round(parseFloat(req.body.salary) * 100);
            const paymentIntent = await stripe.paymentIntents.create({ amount, currency: "usd", payment_method_types: ["card"] });
            res.send({ clientSecret: paymentIntent.client_secret });
        });

        app.post("/payments", verifyToken, async (req, res) => {
            const payment = req.body;
            const paymentResult = await paymentsCollection.insertOne(payment);
            if (payment.appId) {
                await appicationsCollection.updateOne({ _id: new ObjectId(payment.appId) }, { $set: { status: "paid" } });
            }
            res.send({ paymentResult });
        });

        console.log("🚀 Local Server Ready on Port 3000");

    } finally { }
}
run().catch(console.dir);

app.get('/', (req, res) => res.send("eTuition Server Running"));
app.listen(port, () => console.log(`Server port: ${port}`));