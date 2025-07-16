// index.js

require("dotenv").config(); // MUST BE AT THE VERY TOP to ensure environment variables are loaded
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin"); // Firebase Admin SDK
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb"); // Added ObjectId

const app = express();
const port = process.env.PORT || 5000; // Use port from .env or default to 5000

app.use(cors());
app.use(express.json());

// Firebase Admin SDK Initialization
// Decode the base64 encoded service account key from environment variable
// IMPORTANT: Ensure process.env.FB_SERVICE_KEY is correctly base64 encoded JSON in your .env
try {
  const decodedKey = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
    "utf8"
  );
  const serviceAccount = JSON.parse(decodedKey);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log("Firebase Admin SDK initialized successfully.");
} catch (error) {
  console.error(
    "Failed to initialize Firebase Admin SDK. Check FB_SERVICE_KEY in .env:",
    error.message
  );
  // It's crucial to exit or handle this error gracefully if Firebase is mandatory
  process.exit(1);
}

// MongoDB Connection URI from .env
// FIX: Corrected variable name from process.env.URI to process.env.MONGODB_URI
const uri = process.env.URI;

// --- IMPORTANT DEBUGGING STEP (Uncomment to verify URI loading) ---
// console.log("Loaded MONGODB_URI:", uri ? uri.substring(0, 20) + '...' : 'Not Loaded');

// Global database and collection variables
let db;
let usersCollection;
let petsCollection;
let donationCamCollection; // Collection for donation campaigns
let donationsCollection; // Collection for individual donation records
let wantedPetsCollection; // Collection for wanted pet requests

// Stripe Secret Key from .env
// IMPORTANT: Ensure process.env.STRIPE_SECRET_KEY is correctly set in your .env
const stripe = require("stripe")(
  process.env.STRIPE_SECRET_KEY || "sk_test_YOUR_STRIPE_SECRET_KEY_FALLBACK"
);

// MongoDB Connection and Server Start
async function run() {
  // Check if URI is available before attempting connection
  if (!uri) {
    console.error("Error: MONGODB_URI is not defined in your .env file.");
    console.error(
      "Please make sure your .env file is in the root of your project and contains MONGODB_URI='YOUR_CONNECTION_STRING'"
    );
    process.exit(1); // Exit the process if critical environment variable is missing
  }

  try {
    const client = new MongoClient(uri, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
    });

    // Connect the client to the server
    await client.connect();
    console.log("Connected to MongoDB successfully!");

    // Assign collections to global variables
    db = client.db("adopty"); // Your database name
    usersCollection = db.collection("users");
    petsCollection = db.collection("pets");
    donationCamCollection = db.collection("donation-cam"); // Using 'donation-cam' as per your provided code
    donationsCollection = db.collection("donations"); // New collection for individual donations
    wantedPetsCollection = db.collection("wantedPets"); // Initialize wantedPets collection

    // Optional: Log collection counts to confirm data presence
    const userCount = await usersCollection.countDocuments();
    const petCount = await petsCollection.countDocuments();
    const campaignCount = await donationCamCollection.countDocuments();
    const donationCount = await donationsCollection.countDocuments();
    const wantedPetCount = await wantedPetsCollection.countDocuments();

    console.log(`Users in DB: ${userCount}`);
    console.log(`Pets in DB: ${petCount}`);
    console.log(`Donation Campaigns in DB: ${campaignCount}`);
    console.log(`Donations in DB: ${donationCount}`);
    console.log(`Wanted Pet Requests in DB: ${wantedPetCount}`);

    // Firebase Token Verification Middleware
    const verifyFBToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res
          .status(401)
          .send({
            message: "Unauthorized: No token provided or invalid format",
          });
      }
      const token = authHeader.split(" ")[1];

      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded; // Attach decoded token payload to request
        next();
      } catch (error) {
        console.error("Firebase token verification error:", error);
        return res
          .status(403)
          .send({ message: "Forbidden: Invalid or expired token" });
      }
    };

    // --- Define API Routes ---

    // Root route
    app.get("/", (req, res) => {
      res.send("Adopty Backend is running!");
    });

    // User routes
    app.post("/users", async (req, res) => {
      const user = req.body;
      const email = user.email;

      if (!email) {
        return res.status(400).send({ message: "Email is required" });
      }

      const userExists = await usersCollection.findOne({ email });

      if (userExists) {
        await usersCollection.updateOne(
          { email },
          { $set: { last_log_in: user.last_log_in } }
        );
        return res.status(200).send({
          message: "User already exists. last_log_in updated.",
          inserted: false,
        });
      }

      const result = await usersCollection.insertOne(user);
      res.status(201).send(result);
    });

    // Pet data routes (Public)
    app.get("/pets", async (req, res) => {
      try {
        const result = await petsCollection.find().toArray();
        res.send(result);
      } catch (error) {
        console.error("Error fetching pets:", error);
        res.status(500).send({ message: "Internal server error." });
      }
    });

    // Donation Campaign Public Routes
    app.get("/donation-cam", async (req, res) => {
      // Fetches all campaigns
      try {
        const result = await donationCamCollection.find().toArray();
        res.send(result);
      } catch (error) {
        console.error("Error fetching all donation campaigns:", error);
        res.status(500).send({ message: "Internal server error." });
      }
    });

    app.get("/donation-cam/:id", async (req, res) => {
      // Fetches a single campaign by ID
      const campaignId = req.params.id;

      if (!ObjectId.isValid(campaignId)) {
        return res.status(400).send({ message: "Invalid campaign ID format." });
      }

      try {
        const result = await donationCamCollection.findOne({
          _id: new ObjectId(campaignId),
        });
        if (result) {
          res.send(result);
        } else {
          res.status(404).send({ message: "Donation campaign not found." });
        }
      } catch (error) {
        console.error("Error fetching single donation campaign:", error);
        res.status(500).send({ message: "Internal server error." });
      }
    });

    // Get recommended donation campaigns (Public)
    app.get("/recommended-campaigns/:excludeId", async (req, res) => {
      const excludeId = req.params.excludeId;
      const limit = parseInt(req.query.limit) || 3;

      try {
        let query = {};
        if (ObjectId.isValid(excludeId)) {
          query = { _id: { $ne: new ObjectId(excludeId) } };
        }

        const recommended = await donationCamCollection
          .aggregate([{ $match: query }, { $sample: { size: limit } }])
          .toArray();

        res.send(recommended);
      } catch (error) {
        console.error("Error fetching recommended campaigns:", error);
        res.status(500).send({ message: "Internal server error." });
      }
    });

    // Wanted Pets Public Route
    app.get("/wanted-pets", async (req, res) => {
      try {
        const result = await wantedPetsCollection
          .find({ status: "Active" })
          .toArray(); // Only fetch active requests
        res.send(result);
      } catch (error) {
        console.error("Error fetching wanted pets:", error);
        res.status(500).send({ message: "Internal server error." });
      }
    });

    // Secure Routes (require verifyFBToken middleware)

    // Create Stripe Payment Intent
    app.post("/create-payment-intent", verifyFBToken, async (req, res) => {
      const { amount, campaignId } = req.body;
      const authenticatedUserId = req.decoded.uid; // Get UID from verified Firebase token

      if (!amount || amount <= 0 || !campaignId || !authenticatedUserId) {
        return res
          .status(400)
          .send({
            message:
              "Amount, campaign ID, and authenticated user ID are required.",
          });
      }

      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amount, // amount in cents
          currency: "usd",
          metadata: {
            campaignId: campaignId,
            userId: authenticatedUserId,
          },
        });

        res.send({
          clientSecret: paymentIntent.client_secret,
        });
      } catch (error) {
        console.error("Error creating payment intent:", error);
        res.status(500).send({ message: "Failed to create payment intent." });
      }
    });

    // Record Donation after successful payment
    app.post("/record-donation", verifyFBToken, async (req, res) => {
      const { campaignId, amount, paymentIntentId } = req.body;

      // Get donor details from the verified Firebase token
      const authenticatedDonorId = req.decoded.uid;
      const authenticatedDonorName = req.decoded.name || req.decoded.email; // Use name if available, else email
      const authenticatedDonorEmail = req.decoded.email;

      if (!campaignId || !amount || !authenticatedDonorId || !paymentIntentId) {
        return res
          .status(400)
          .send({
            message:
              "Missing required donation details for authenticated user.",
          });
      }

      try {
        const updateResult = await donationCamCollection.updateOne(
          { _id: new ObjectId(campaignId) },
          {
            $inc: { donatedAmount: amount, donorCount: 1 },
          }
        );

        if (updateResult.matchedCount === 0) {
          return res
            .status(404)
            .send({
              success: false,
              message: "Donation campaign not found for update.",
            });
        }

        const donationRecord = {
          campaignId: new ObjectId(campaignId),
          amount: amount,
          donorId: authenticatedDonorId,
          donorName: authenticatedDonorName,
          donorEmail: authenticatedDonorEmail,
          paymentIntentId: paymentIntentId,
          donationDate: new Date(),
        };
        await donationsCollection.insertOne(donationRecord);

        res.send({ success: true, message: "Donation recorded successfully!" });
      } catch (error) {
        console.error("Error recording donation:", error);
        res
          .status(500)
          .send({
            success: false,
            message: "Internal server error during donation recording.",
          });
      }
    });

    app.post("/donation-cam", verifyFBToken, async (req, res) => {
      const newCampaign = req.body;
      const creatorId = req.decoded.uid; // Get creator's UID from verified token

      // Basic validation (add more as needed)
      if (
        !newCampaign.petName ||
        !newCampaign.targetAmount ||
        !newCampaign.category ||
        !creatorId
      ) {
        return res
          .status(400)
          .send({ message: "Missing required campaign fields." });
      }
      if (
        typeof newCampaign.targetAmount !== "number" ||
        newCampaign.targetAmount <= 0
      ) {
        return res
          .status(400)
          .send({ message: "Target amount must be a positive number." });
      }
      if (
        typeof newCampaign.daysLeft !== "number" ||
        newCampaign.daysLeft <= 0
      ) {
        return res
          .status(400)
          .send({ message: "Days left must be a positive integer." });
      }

      try {
        const campaignToInsert = {
          ...newCampaign,
          createdByUserId: creatorId, // Store the Firebase UID of the creator
          createdAt: new Date(), // Store creation date as a Date object
          donatedAmount: 0, // Ensure initial donated amount is 0
          donorCount: 0, // Ensure initial donor count is 0
        };

        const result = await donationCamCollection.insertOne(campaignToInsert);
        res
          .status(201)
          .send({
            success: true,
            message: "Campaign created successfully!",
            insertedId: result.insertedId,
          });
      } catch (error) {
        console.error("Error creating new donation campaign:", error);
        res
          .status(500)
          .send({ message: "Failed to create donation campaign." });
      }
    });














    

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

// Start the Express server
app.listen(port, () => {
  console.log(`Adopty Backend listening on port ${port}`);
});
