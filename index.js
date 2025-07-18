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
        return res.status(401).send({
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
        return res.status(400).send({
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
        return res.status(400).send({
          message: "Missing required donation details for authenticated user.",
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
          return res.status(404).send({
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
        res.status(500).send({
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
        res.status(201).send({
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

    // User

    // NEW: Add a Pet (Protected)
    app.post("/pets", verifyFBToken, async (req, res) => {
      const newPet = req.body;
      const creatorId = req.decoded.uid; // Get creator's UID from verified token

      // Basic validation (add more as needed)
      if (
        !newPet.petName ||
        !newPet.petImage ||
        !newPet.petCategory ||
        !newPet.petLocation ||
        !creatorId
      ) {
        return res
          .status(400)
          .send({
            message:
              "Missing required pet fields (name, image, category, location, creator).",
          });
      }
      if (typeof newPet.petAge !== "number" || newPet.petAge < 0) {
        return res
          .status(400)
          .send({ message: "Pet age must be a non-negative number." });
      }

      try {
        const petToInsert = {
          ...newPet,
          createdByUserId: creatorId, // Store the Firebase UID of the creator
          createdAt: new Date(), // Store creation date as a Date object
          adopted: false, // Default status
        };

        const result = await petsCollection.insertOne(petToInsert);
        res
          .status(201)
          .send({
            success: true,
            message: "Pet added successfully!",
            insertedId: result.insertedId,
          });
      } catch (error) {
        console.error("Error adding new pet:", error);
        res.status(500).send({ message: "Failed to add pet." });
      }
    });




    // NEW: Get Pets added by a specific user (Protected)
app.get("/user-pets/:userId", verifyFBToken, async (req, res) => {
  const requestedUserId = req.params.userId;
  const authUserId = req.decoded.uid; // User ID from the authenticated token

  // Ensure the requested user ID matches the authenticated user's ID
  // Or, if an admin is requesting, allow it (add verifyAdmin if needed for admin access)
  if (requestedUserId !== authUserId) {
    return res.status(403).send({ message: "Forbidden: You can only view your own added pets." });
  }

  try {
    const pets = await petsCollection.find({ createdByUserId: requestedUserId }).toArray();
    res.send(pets);
  } catch (error) {
    console.error("Error fetching user's pets:", error);
    res.status(500).send({ message: "Failed to retrieve pets." });
  }
});

// NEW: Delete a Pet (Protected - only by creator or admin)
app.delete("/pets/:id", verifyFBToken, async (req, res) => {
  const petId = req.params.id;
  const authUserId = req.decoded.uid; // User ID from the authenticated token
  const userRole = req.decoded.role; // Role from the authenticated token (if available)

  if (!ObjectId.isValid(petId)) {
    return res.status(400).send({ message: "Invalid pet ID format." });
  }

  try {
    const pet = await petsCollection.findOne({ _id: new ObjectId(petId) });

    if (!pet) {
      return res.status(404).send({ message: "Pet not found." });
    }

    // Check if the user is the creator of the pet OR if the user is an admin
    if (pet.createdByUserId !== authUserId && userRole !== 'admin') {
      return res.status(403).send({ message: "Forbidden: You do not have permission to delete this pet." });
    }

    const result = await petsCollection.deleteOne({ _id: new ObjectId(petId) });
    if (result.deletedCount === 1) {
      res.send({ success: true, message: "Pet deleted successfully." });
    } else {
      res.status(404).send({ message: "Pet not found or already deleted." });
    }
  } catch (error) {
    console.error("Error deleting pet:", error);
    res.status(500).send({ message: "Failed to delete pet." });
  }
});

// NEW: Update Pet Adoption Status (Protected - only by creator or admin)
app.patch("/pets/status/:id", verifyFBToken, async (req, res) => {
  const petId = req.params.id;
  const { adopted } = req.body; // Expecting { adopted: true/false }
  const authUserId = req.decoded.uid;
  const userRole = req.decoded.role;

  if (!ObjectId.isValid(petId)) {
    return res.status(400).send({ message: "Invalid pet ID format." });
  }
  if (typeof adopted !== 'boolean') {
    return res.status(400).send({ message: "Invalid 'adopted' status. Must be true or false." });
  }

  try {
    const pet = await petsCollection.findOne({ _id: new ObjectId(petId) });

    if (!pet) {
      return res.status(404).send({ message: "Pet not found." });
    }

    // Check if the user is the creator of the pet OR if the user is an admin
    if (pet.createdByUserId !== authUserId && userRole !== 'admin') {
      return res.status(403).send({ message: "Forbidden: You do not have permission to update this pet status." });
    }

    const result = await petsCollection.updateOne(
      { _id: new ObjectId(petId) },
      { $set: { adopted: adopted } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({ message: "Pet not found or status already updated." });
    }
    res.send({ success: true, message: `Pet adoption status updated to ${adopted}.` });
  } catch (error) {
    console.error("Error updating pet status:", error);
    res.status(500).send({ message: "Failed to update pet status." });
  }
});

    // Admin
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email: email };
      try {
        const user = await usersCollection.findOne(query);
        if (!user || user.role !== "admin") {
          return res
            .status(403)
            .send({ message: "Forbidden: Admin access required" });
        }
        next();
      } catch (error) {
        console.error("Error verifying admin role:", error);
        res
          .status(500)
          .send({
            message: "Internal server error during admin verification.",
          });
      }
    };

    // NEW: Verify Volunteer Middleware
    const verifyVolunteer = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email: email };
      try {
        const user = await usersCollection.findOne(query);
        // Allow both 'admin' and 'volunteer' roles to pass this middleware
        if (!user || (user.role !== "volunteer" && user.role !== "admin")) {
          return res
            .status(403)
            .send({ message: "Forbidden: Volunteer or Admin access required" });
        }
        next();
      } catch (error) {
        console.error("Error verifying volunteer role:", error);
        res
          .status(500)
          .send({
            message: "Internal server error during volunteer verification.",
          });
      }
    };

    // --- Define API Routes ---

    // User routes (MODIFIED: Default role for new users)
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
          user: userExists, // Send existing user data
        });
      }

      // For new users, default role to 'user'
      const newUser = { ...user, role: "user" }; // Default role for new users
      const result = await usersCollection.insertOne(newUser);
      res.status(201).send({ ...result, user: newUser }); // Send back new user data
    });

    // Get User by Email (for fetching role) - Protected by verifyFBToken
    app.get("/users/:email", verifyFBToken, async (req, res) => {
      const requestedEmail = req.params.email;
      // Ensure the requested email matches the authenticated user's email
      if (req.decoded.email !== requestedEmail) {
        return res
          .status(403)
          .send({
            message: "Forbidden: You can only view your own user data.",
          });
      }
      try {
        const user = await usersCollection.findOne({ email: requestedEmail });
        if (user) {
          res.send(user); // Send back the user object including their role
        } else {
          res.status(404).send({ message: "User not found." });
        }
      } catch (error) {
        console.error("Error fetching user by email:", error);
        res.status(500).send({ message: "Internal server error." });
      }
    });

    // ... (existing public routes)

    // ... (existing secure routes)

    // ADMIN-ONLY ROUTES (Protected by verifyFBToken AND verifyAdmin)
    app.get("/admin/users", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const users = await usersCollection.find({}).toArray();
        res.send(users);
      } catch (error) {
        console.error("Error fetching all users (admin):", error);
        res.status(500).send({ message: "Internal server error." });
      }
    });

    app.get("/admin/pets", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const pets = await petsCollection.find({}).toArray();
        res.send(pets);
      } catch (error) {
        console.error("Error fetching all pets (admin):", error);
        res.status(500).send({ message: "Internal server error." });
      }
    });

    app.get(
      "/admin/donation-campaigns",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const campaigns = await donationCamCollection.find({}).toArray();
          res.send(campaigns);
        } catch (error) {
          console.error(
            "Error fetching all donation campaigns (admin):",
            error
          );
          res.status(500).send({ message: "Internal server error." });
        }
      }
    );

    app.get(
      "/admin/donations",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const donations = await donationsCollection.find({}).toArray();
          res.send(donations);
        } catch (error) {
          console.error("Error fetching all donations (admin):", error);
          res.status(500).send({ message: "Internal server error." });
        }
      }
    );

    // NEW ADMIN ROUTE: Update User Role
    app.patch(
      "/admin/users/role/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const userId = req.params.id;
        const { role } = req.body; // Expected role: 'user', 'admin', or 'volunteer'

        if (!role || !["user", "admin", "volunteer"].includes(role)) {
          return res
            .status(400)
            .send({
              message:
                "Invalid role provided. Must be 'user', 'admin', or 'volunteer'.",
            });
        }
        if (!ObjectId.isValid(userId)) {
          return res.status(400).send({ message: "Invalid user ID format." });
        }

        try {
          const result = await usersCollection.updateOne(
            { _id: new ObjectId(userId) },
            { $set: { role: role } }
          );

          if (result.matchedCount === 0) {
            return res.status(404).send({ message: "User not found." });
          }
          res.send({ success: true, message: `User role updated to ${role}.` });
        } catch (error) {
          console.error("Error updating user role:", error);
          res.status(500).send({ message: "Internal server error." });
        }
      }
    );

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
