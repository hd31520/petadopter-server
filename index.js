require("dotenv").config(); // MUST BE AT THE VERY TOP to ensure environment variables are loaded
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin"); // Firebase Admin SDK
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb"); // Added ObjectId

const app = express();
const port = process.env.PORT || 5000; // Use port from .env or default to 5000

// Middleware
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
  process.exit(1); // Exit if Firebase Admin SDK fails to initialize
}

// MongoDB Connection URI from .env
const uri = process.env.URI;

// Global database and collection variables
let db;
let usersCollection;
let petsCollection;
let donationCamCollection; // Collection for donation campaigns
let donationsCollection; // Collection for individual donation records
let wantedPetsCollection; // Collection for wanted pet requests
let adoptionRequestsCollection;

// Stripe Secret Key from .env
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
    wantedPetsCollection = db.collection("wantedPets");
    adoptionRequestsCollection = db.collection("adoptionRequests");

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
    // This middleware verifies the Firebase ID token and attaches the decoded payload to req.decoded
    const verifyFBToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).send({
          message: "Unauthorized: No token provided or invalid format",
        });
      }
      const token = authHeader.split(" ")[1];

      try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.decoded = decodedToken; // Attach decoded token payload to request
        next();
      } catch (error) {
        console.error("Firebase token verification error:", error);
        return res
          .status(403)
          .send({ message: "Forbidden: Invalid or expired token" });
      }
    };

    // Middleware to fetch user role and attach to req.decoded
    // This should run AFTER verifyFBToken if you need role for other middlewares
    const attachUserRole = async (req, res, next) => {
      if (!req.decoded || !req.decoded.email) {
        // If verifyFBToken didn't run or failed, or email is missing
        return res
          .status(401)
          .send({ message: "Unauthorized: User email not found." });
      }
      try {
        const user = await usersCollection.findOne({
          email: req.decoded.email,
        });
        if (user) {
          req.decoded.role = user.role; // Attach role to the decoded token payload
        } else {
          // If user not found in DB, assign a default role or deny access
          req.decoded.role = "unknown"; // Or handle as per your app logic
        }
        next();
      } catch (error) {
        console.error("Error attaching user role:", error);
        res
          .status(500)
          .send({ message: "Internal server error during role attachment." });
      }
    };

    // Admin Middleware (Requires verifyFBToken and attachUserRole before it)
    const verifyAdmin = (req, res, next) => {
      if (!req.decoded || req.decoded.role !== "admin") {
        return res
          .status(403)
          .send({ message: "Forbidden: Admin access required" });
      }
      next();
    };

    // Volunteer Middleware (Requires verifyFBToken and attachUserRole before it)
    const verifyVolunteer = (req, res, next) => {
      if (
        !req.decoded ||
        (req.decoded.role !== "volunteer" && req.decoded.role !== "admin")
      ) {
        return res
          .status(403)
          .send({ message: "Forbidden: Volunteer or Admin access required" });
      }
      next();
    };

    // --- Define API Routes ---

    // Root route
    app.get("/", (req, res) => {
      res.send("Adopty Backend is running!");
    });

    // User routes (Handles both new user creation and existing user login updates)
    app.post("/users", async (req, res) => {
      const user = req.body;
      const email = user.email;

      if (!email) {
        return res.status(400).send({ message: "Email is required" });
      }

      try {
        const userExists = await usersCollection.findOne({ email });

        if (userExists) {
          // Update existing user's last_log_in and other profile data if provided
          const updateDoc = {
            $set: {
              last_log_in: user.last_log_in || new Date().toISOString(),
              displayName: user.displayName || userExists.displayName,
              photoURL: user.photoURL || userExists.photoURL,
              // Do not update role here, roles should be managed by admin
            },
          };
          await usersCollection.updateOne({ email }, updateDoc);
          return res.status(200).send({
            message: "User already exists. last_log_in updated.",
            inserted: false,
            user: { ...userExists, ...user }, // Return updated user data (merge for client)
          });
        }

        // For new users, default role to 'user'
        const newUser = {
          ...user,
          role: user.role || "user", // Default role for new users
          createdAt: new Date().toISOString(), // Add creation timestamp
          last_log_in: new Date().toISOString(), // Add last login timestamp
        };
        const result = await usersCollection.insertOne(newUser);
        res.status(201).send({ ...result, user: newUser }); // Send back new user data
      } catch (error) {
        console.error("Error processing user:", error);
        res.status(500).send({ message: "Failed to process user data." });
      }
    });

    // Get All Users (Admin only)
    app.get(
      "/users",
      verifyFBToken,
      attachUserRole,
      verifyAdmin,
      async (req, res) => {
        try {
          const users = await usersCollection.find().toArray();
          res.send(users);
        } catch (error) {
          console.error("Error fetching all users:", error);
          res.status(500).send({ message: "Failed to retrieve users." });
        }
      }
    );

    // Get User by Email (for fetching role) - Protected by verifyFBToken
    app.get(
      "/users/:email",
      verifyFBToken,
      attachUserRole,
      async (req, res) => {
        const requestedEmail = req.params.email;
        // Ensure the requested email matches the authenticated user's email or if user is admin
        if (
          req.decoded.email !== requestedEmail &&
          req.decoded.role !== "admin"
        ) {
          return res.status(403).send({
            message:
              "Forbidden: You can only view your own user data unless you are an admin.",
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
          console.error("Error fetching user:", error);
          res.status(500).send({ message: "Failed to retrieve user." });
        }
      }
    );

    // Update User Role (Admin only)
    app.patch(
      "/users/role/:id",
      verifyFBToken,
      attachUserRole,
      verifyAdmin,
      async (req, res) => {
        const userId = req.params.id;
        const { role } = req.body; // Expecting { role: "admin" | "volunteer" | "user" }

        if (!ObjectId.isValid(userId)) {
          return res.status(400).send({ message: "Invalid user ID format." });
        }
        if (!["admin", "volunteer", "user"].includes(role)) {
          return res.status(400).send({ message: "Invalid role specified." });
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
          res.status(500).send({ message: "Failed to update user role." });
        }
      }
    );

    // Delete User (Admin only)
    app.delete(
      "/users/:id",
      verifyFBToken,
      attachUserRole,
      verifyAdmin,
      async (req, res) => {
        const userId = req.params.id;

        if (!ObjectId.isValid(userId)) {
          return res.status(400).send({ message: "Invalid user ID format." });
        }

        try {
          const result = await usersCollection.deleteOne({
            _id: new ObjectId(userId),
          });
          if (result.deletedCount === 1) {
            res.send({ success: true, message: "User deleted successfully." });
          } else {
            res
              .status(404)
              .send({ message: "User not found or already deleted." });
          }
        } catch (error) {
          console.error("Error deleting user:", error);
          res.status(500).send({ message: "Failed to delete user." });
        }
      }
    );

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

    // Get a single pet by ID (PUBLIC)
    app.get("/pets/:id", async (req, res) => {
      const petId = req.params.id;

      if (!ObjectId.isValid(petId)) {
        return res.status(400).send({ message: "Invalid pet ID format." });
      }

      try {
        const pet = await petsCollection.findOne({ _id: new ObjectId(petId) });

        if (!pet) {
          return res.status(404).send({ message: "Pet not found." });
        }
        res.send(pet);
      } catch (error) {
        console.error("Error fetching single pet:", error);
        res.status(500).send({ message: "Failed to retrieve pet." });
      }
    });

    // Add a Pet (Protected - any logged-in user can add)
    app.post("/pets", verifyFBToken, attachUserRole, async (req, res) => {
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
        return res.status(400).send({
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
        res.status(201).send({
          success: true,
          message: "Pet added successfully!",
          insertedId: result.insertedId,
        });
      } catch (error) {
        console.error("Error adding new pet:", error);
        res.status(500).send({ message: "Failed to add pet." });
      }
    });

    // Get Pets added by a specific user (Protected - user can only view their own, admin can view all)
    app.get(
      "/user-pets/:userId",
      verifyFBToken,
      attachUserRole,
      async (req, res) => {
        const requestedUserId = req.params.userId;
        const authUserId = req.decoded.uid; // User ID from the authenticated token
        const userRole = req.decoded.role;

        // Allow if the requested ID matches the authenticated user's ID OR if the user is an admin
        if (requestedUserId !== authUserId && userRole !== "admin") {
          return res.status(403).send({
            message:
              "Forbidden: You can only view your own added pets unless you are an admin.",
          });
        }

        try {
          const pets = await petsCollection
            .find({ createdByUserId: requestedUserId })
            .toArray();
          res.send(pets);
        } catch (error) {
          console.error("Error fetching user's pets:", error);
          res.status(500).send({ message: "Failed to retrieve pets." });
        }
      }
    );

    // Delete a Pet (Protected - only by creator or admin)
    app.delete("/pets/:id", verifyFBToken, attachUserRole, async (req, res) => {
      const petId = req.params.id;
      const authUserId = req.decoded.uid; // User ID from the authenticated token
      const userRole = req.decoded.role;

      if (!ObjectId.isValid(petId)) {
        return res.status(400).send({ message: "Invalid pet ID format." });
      }

      try {
        const pet = await petsCollection.findOne({ _id: new ObjectId(petId) });

        if (!pet) {
          return res.status(404).send({ message: "Pet not found." });
        }

        // Check if the user is the creator of the pet OR if the user is an admin
        if (pet.createdByUserId !== authUserId && userRole !== "admin") {
          return res.status(403).send({
            message:
              "Forbidden: You do not have permission to delete this pet.",
          });
        }

        const result = await petsCollection.deleteOne({
          _id: new ObjectId(petId),
        });
        if (result.deletedCount === 1) {
          res.send({ success: true, message: "Pet deleted successfully." });
        } else {
          res
            .status(404)
            .send({ message: "Pet not found or already deleted." });
        }
      } catch (error) {
        console.error("Error deleting pet:", error);
        res.status(500).send({ message: "Failed to delete pet." });
      }
    });

    // Update Pet Adoption Status (Protected - only by creator or admin)
    app.patch(
      "/pets/status/:id",
      verifyFBToken,
      attachUserRole,
      async (req, res) => {
        const petId = req.params.id;
        const { adopted } = req.body; // Expecting { adopted: true/false }
        const authUserId = req.decoded.uid;
        const userRole = req.decoded.role;

        if (!ObjectId.isValid(petId)) {
          return res.status(400).send({ message: "Invalid pet ID format." });
        }
        if (typeof adopted !== "boolean") {
          return res.status(400).send({
            message: "Invalid 'adopted' status. Must be true or false.",
          });
        }

        try {
          const pet = await petsCollection.findOne({
            _id: new ObjectId(petId),
          });

          if (!pet) {
            return res.status(404).send({ message: "Pet not found." });
          }

          // Check if the user is the creator of the pet OR if the user is an admin
          if (pet.createdByUserId !== authUserId && userRole !== "admin") {
            return res.status(403).send({
              message:
                "Forbidden: You do not have permission to update this pet status.",
            });
          }

          if (pet.adopted === adopted) {
            // No change needed
            return res.status(200).send({
              success: false,
              message: "Pet status is already as requested.",
            });
          }

          const result = await petsCollection.updateOne(
            { _id: new ObjectId(petId) },
            { $set: { adopted: adopted } }
          );

          if (result.matchedCount === 0) {
            return res
              .status(404)
              .send({ message: "Pet not found or status already updated." });
          }
          res.send({
            success: true,
            message: `Pet adoption status updated to ${adopted}.`,
          });
        } catch (error) {
          console.error("Error updating pet status:", error);
          res.status(500).send({ message: "Failed to update pet status." });
        }
      }
    );

    // Update a Pet's details (Protected - only by creator or admin)
    app.patch("/pets/:id", verifyFBToken, attachUserRole, async (req, res) => {
      const petId = req.params.id;
      const updatedPetData = req.body;
      const authUserId = req.decoded.uid;
      const userRole = req.decoded.role;

      if (!ObjectId.isValid(petId)) {
        return res.status(400).send({ message: "Invalid pet ID format." });
      }

      try {
        const pet = await petsCollection.findOne({ _id: new ObjectId(petId) });

        if (!pet) {
          return res.status(404).send({ message: "Pet not found." });
        }

        // Ensure the user is the creator of the pet OR an admin
        if (pet.createdByUserId !== authUserId && userRole !== "admin") {
          return res.status(403).send({
            message:
              "Forbidden: You do not have permission to update this pet.",
          });
        }

        // Prepare update document, exclude _id and createdByUserId, createdAt, adopted from direct update
        const { _id, createdByUserId, createdAt, adopted, ...dataToUpdate } =
          updatedPetData;

        // Optionally, ensure petAge is a number if it's being updated
        if (
          dataToUpdate.petAge !== undefined &&
          typeof dataToUpdate.petAge !== "number"
        ) {
          dataToUpdate.petAge = parseInt(dataToUpdate.petAge);
          if (isNaN(dataToUpdate.petAge) || dataToUpdate.petAge < 0) {
            return res
              .status(400)
              .send({ message: "Pet age must be a non-negative number." });
          }
        }

        const result = await petsCollection.updateOne(
          { _id: new ObjectId(petId) },
          { $set: dataToUpdate }
        );

        if (result.matchedCount === 0) {
          return res
            .status(404)
            .send({ message: "Pet not found or no changes made." });
        }
        res.send({ success: true, message: "Pet updated successfully!" });
      } catch (error) {
        console.error("Error updating pet:", error);
        res.status(500).send({ message: "Failed to update pet." });
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

    // Create Donation Campaign (Protected - any logged-in user)
    app.post(
      "/donation-cam",
      verifyFBToken,
      attachUserRole,
      async (req, res) => {
        const newCampaign = req.body;
        const creatorId = req.decoded.uid; // Get creator's UID from verified token

        // Basic validation (add more as needed)
        if (
          !newCampaign.petName ||
          !newCampaign.targetAmount ||
          !newCampaign.category ||
          !newCampaign.endDate || // Ensure endDate is provided
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

        // Validate endDate
        const endDate = new Date(newCampaign.endDate);
        if (isNaN(endDate.getTime())) {
          // Check for invalid date
          return res.status(400).send({ message: "Invalid endDate format." });
        }
        if (endDate < new Date()) {
          return res
            .status(400)
            .send({ message: "End date cannot be in the past." });
        }

        try {
          const campaignToInsert = {
            ...newCampaign,
            createdByUserId: creatorId, // Store the Firebase UID of the creator
            createdAt: new Date(), // Store creation date as a Date object
            donatedAmount: 0, // Ensure initial donated amount is 0
            donorCount: 0, // Ensure initial donor count is 0
          };

          const result = await donationCamCollection.insertOne(
            campaignToInsert
          );
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
      }
    );

    // Update Donation Campaign (Protected - only by creator or admin)
    app.patch(
      "/donation-cam/:id",
      verifyFBToken,
      attachUserRole,
      async (req, res) => {
        const campaignId = req.params.id;
        const updatedCampaignData = req.body;
        const authUserId = req.decoded.uid;
        const userRole = req.decoded.role;

        if (!ObjectId.isValid(campaignId)) {
          return res
            .status(400)
            .send({ message: "Invalid campaign ID format." });
        }

        try {
          const campaign = await donationCamCollection.findOne({
            _id: new ObjectId(campaignId),
          });

          if (!campaign) {
            return res
              .status(404)
              .send({ message: "Donation campaign not found." });
          }

          // Ensure the user is the creator of the campaign OR an admin
          if (campaign.createdByUserId !== authUserId && userRole !== "admin") {
            return res.status(403).send({
              message:
                "Forbidden: You do not have permission to update this campaign.",
            });
          }

          // Prepare update document, exclude _id, createdByUserId, createdAt, donatedAmount, donorCount
          const {
            _id,
            createdByUserId,
            createdAt,
            donatedAmount,
            donorCount,
            ...dataToUpdate
          } = updatedCampaignData;

          // Basic validation for updated fields (e.g., targetAmount)
          if (dataToUpdate.targetAmount !== undefined) {
            dataToUpdate.targetAmount = parseFloat(dataToUpdate.targetAmount);
            if (
              isNaN(dataToUpdate.targetAmount) ||
              dataToUpdate.targetAmount <= 0
            ) {
              return res
                .status(400)
                .send({ message: "Target amount must be a positive number." });
            }
          }
          if (dataToUpdate.endDate !== undefined) {
            const endDate = new Date(dataToUpdate.endDate);
            if (isNaN(endDate.getTime())) {
              return res
                .status(400)
                .send({ message: "Invalid endDate format." });
            }
            if (endDate < new Date()) {
              // Allow updating to a past date only if the campaign is already ended
              if (campaign.donatedAmount < campaign.targetAmount) {
                // If not fully funded
                return res.status(400).send({
                  message:
                    "Cannot set end date to past if campaign is not fully funded.",
                });
              }
            }
          }

          const result = await donationCamCollection.updateOne(
            { _id: new ObjectId(campaignId) },
            { $set: dataToUpdate }
          );

          if (result.matchedCount === 0) {
            return res
              .status(404)
              .send({ message: "Campaign not found or no changes made." });
          }
          res.send({
            success: true,
            message: "Donation campaign updated successfully!",
          });
        } catch (error) {
          console.error("Error updating donation campaign:", error);
          res
            .status(500)
            .send({ message: "Failed to update donation campaign." });
        }
      }
    );

    // Pause/Unpause Donation Campaign (Admin or Creator)
    app.patch(
      "/donation-cam/status/:id",
      verifyFBToken,
      attachUserRole,
      async (req, res) => {
        const campaignId = req.params.id;
        const { paused } = req.body; // Expecting { paused: true/false }
        const authUserId = req.decoded.uid;
        const userRole = req.decoded.role;

        if (!ObjectId.isValid(campaignId)) {
          return res
            .status(400)
            .send({ message: "Invalid campaign ID format." });
        }
        if (typeof paused !== "boolean") {
          return res.status(400).send({
            message: "Invalid 'paused' status. Must be true or false.",
          });
        }

        try {
          const campaign = await donationCamCollection.findOne({
            _id: new ObjectId(campaignId),
          });

          if (!campaign) {
            return res
              .status(404)
              .send({ message: "Donation campaign not found." });
          }

          if (campaign.createdByUserId !== authUserId && userRole !== "admin") {
            return res.status(403).send({
              message:
                "Forbidden: You do not have permission to change this campaign's status.",
            });
          }

          const result = await donationCamCollection.updateOne(
            { _id: new ObjectId(campaignId) },
            { $set: { paused: paused } }
          );

          if (result.matchedCount === 0) {
            return res.status(404).send({
              message: "Campaign not found or status already updated.",
            });
          }
          res.send({ success: true, message: `Campaign status updated to paused: ${paused}.` });
        } catch (error) {
          console.error("Error updating campaign status:", error);
          res.status(500).send({ message: "Failed to update campaign status." });
        }
      }
    );

    // Delete Donation Campaign (Admin or Creator)
    app.delete("/donation-cam/:id", verifyFBToken, attachUserRole, async (req, res) => {
      const campaignId = req.params.id;
      const authUserId = req.decoded.uid;
      const userRole = req.decoded.role;

      if (!ObjectId.isValid(campaignId)) {
        return res.status(400).send({ message: "Invalid campaign ID format." });
      }

      try {
        const campaign = await donationCamCollection.findOne({ _id: new ObjectId(campaignId) });

        if (!campaign) {
          return res.status(404).send({ message: "Donation campaign not found." });
        }

        if (campaign.createdByUserId !== authUserId && userRole !== "admin") {
          return res.status(403).send({
            message: "Forbidden: You do not have permission to delete this campaign.",
          });
        }

        const result = await donationCamCollection.deleteOne({ _id: new ObjectId(campaignId) });
        if (result.deletedCount === 1) {
          res.send({ success: true, message: "Donation campaign deleted successfully." });
        } else {
          res.status(404).send({ message: "Donation campaign not found or already deleted." });
        }
      } catch (error) {
        console.error("Error deleting campaign:", error);
        res.status(500).send({ message: "Failed to delete campaign." });
      }
    });

    // Get My Created Donation Campaigns (Protected - by creator)
    app.get("/my-donation-campaigns/:userId", verifyFBToken, attachUserRole, async (req, res) => {
      const requestedUserId = req.params.userId;
      const authUserId = req.decoded.uid;

      if (requestedUserId !== authUserId && req.decoded.role !== 'admin') {
        return res.status(403).send({
          message: "Forbidden: You can only view your own campaigns unless you are an admin.",
        });
      }
      try {
        const campaigns = await donationCamCollection.find({ createdByUserId: requestedUserId }).toArray();
        res.send(campaigns);
      } catch (error) {
        console.error("Error fetching user's donation campaigns:", error);
        res.status(500).send({ message: "Failed to retrieve campaigns." });
      }
    });

    // Get All Donations (Admin only)
    app.get("/all-donations", verifyFBToken, attachUserRole, verifyAdmin, async (req, res) => {
      try {
        const donations = await donationsCollection.find().toArray();
        res.send(donations);
      } catch (error) {
        console.error("Error fetching all donations:", error);
        res.status(500).send({ message: "Failed to retrieve donations." });
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

    // Adoption Request API Endpoints

    // Submit an Adoption Request (Protected - by any logged-in user)
    app.post("/adoption-requests", verifyFBToken, attachUserRole, async (req, res) => {
      const requestData = req.body;
      const requesterId = req.decoded.uid;

      // Basic validation: ownerId is now optional, but other fields are still required
      if (
        !requestData.petId ||
        !requestData.requesterName ||
        !requestData.requesterEmail ||
        !requestData.requesterPhone ||
        !requestData.requesterLocation ||
        !requestData.petName || // Added validation for petName
        !requestData.petImage // Added validation for petImage
      ) {
        return res
          .status(400)
          .send({ message: "Missing required fields for adoption request." });
      }

      try {
        // Ensure the pet exists and is not already adopted
        const pet = await petsCollection.findOne({
          _id: new ObjectId(requestData.petId),
        });
        if (!pet) {
          return res.status(404).send({ message: "Pet not found." });
        }
        if (pet.adopted) {
          return res
            .status(400)
            .send({ message: "This pet has already been adopted." });
        }

        // IMPORTANT: Modify "Prevent a user from requesting their own pet" check
        // This check now only applies if pet.createdByUserId actually exists on the pet object.
        // If createdByUserId is missing (e.g., for older data), this check is skipped.
        if (pet.createdByUserId && pet.createdByUserId === requesterId) {
          return res
            .status(400)
            .send({ message: "You cannot request to adopt your own pet." });
        }

        // Check if this user has already requested this pet
        const existingRequest = await adoptionRequestsCollection.findOne({
          petId: requestData.petId,
          requesterId: requesterId,
          status: { $in: ["pending", "accepted"] }, // Check for pending or already accepted requests
        });

        if (existingRequest) {
          return res.status(400).send({
            message:
              "You have already submitted an adoption request for this pet.",
          });
        }

        const requestToInsert = {
          ...requestData, // This includes petId, ownerId (can be null), requesterName, etc.
          requesterId: requesterId, // The ID of the user making the request
          requestDate: new Date(), // Store request date
          status: "pending", // Default status
          // petName and petImage are now expected to be in requestData from frontend
          // so no need to derive from `pet` object here.
          // If you want to ensure they are consistent with the DB, you could use:
          // petName: pet.name,
          // petImage: pet.image,
        };

        const result = await adoptionRequestsCollection.insertOne(
          requestToInsert
        );
        res.status(201).send({
          success: true,
          message: "Adoption request submitted successfully!",
          insertedId: result.insertedId,
        });
      } catch (error) {
        console.error("Error submitting adoption request:", error);
        res.status(500).send({ message: "Failed to submit adoption request." });
      }
    });

    // Get Adoption Requests for Pets Owned by Current User (Protected)
    app.get(
      "/owner-adoption-requests/:ownerId",
      verifyFBToken,
      attachUserRole,
      async (req, res) => {
        const requestedOwnerId = req.params.ownerId;
        const authUserId = req.decoded.uid; // User ID from the authenticated token

        // Ensure the requested owner ID matches the authenticated user's ID
        // Or if an admin is requesting
        if (requestedOwnerId !== authUserId && req.decoded.role !== 'admin') {
          return res.status(403).send({
            message: "Forbidden: You can only view requests for your own pets unless you are an admin.",
          });
        }

        try {
          // Find all pets owned by this user
          const ownedPets = await petsCollection
            .find({ createdByUserId: requestedOwnerId })
            .toArray();
          const ownedPetIds = ownedPets.map((pet) => pet._id.toString()); // Get IDs as strings

          // Find adoption requests for these pets
          const requests = await adoptionRequestsCollection
            .find({
              petId: { $in: ownedPetIds }, // Match requests where petId is one of the owned pets
            })
            .toArray();

          res.send(requests);
        } catch (error) {
          console.error("Error fetching owner's adoption requests:", error);
          res
            .status(500)
            .send({ message: "Failed to retrieve adoption requests." });
        }
      }
    );

    // Update Adoption Request Status (Accept/Reject) (Protected - by owner or admin)
    app.patch(
      "/adoption-requests/status/:id",
      verifyFBToken,
      attachUserRole,
      async (req, res) => {


        const requestId = req.params.id;
        const { status } = req.body; // Expecting { status: 'accepted' | 'rejected' }
        const authUserId = req.decoded.uid;
        const userRole = req.decoded.role;

        if (!ObjectId.isValid(requestId)) {
          return res
            .status(400)
            .send({ message: "Invalid request ID format." });
        }
        if (!["accepted", "rejected"].includes(status)) {
          return res.status(400).send({
            message: "Invalid status. Must be 'accepted' or 'rejected'.",
          });
        }

        try {
          const request = await adoptionRequestsCollection.findOne({
            _id: new ObjectId(requestId),
          });

          if (!request) {
            return res
              .status(404)
              .send({ message: "Adoption request not found." });
          }

          // Verify ownership: Check if the user is the owner of the pet associated with the request
          const pet = await petsCollection.findOne({
            _id: new ObjectId(request.petId),
          });
          if (!pet) {
            return res
              .status(404)
              .send({ message: "Associated pet not found." });
          }

          // This check also needs to be robust against missing createdByUserId
          if (pet.createdByUserId && pet.createdByUserId !== authUserId && userRole !== "admin") {
            return res.status(403).send({
              message:
                "Forbidden: You do not have permission to update this request.",
            });
          }

          // Only allow status change from 'pending'
          if (request.status !== "pending") {
            return res.status(400).send({
              message: `Request is already ${request.status}. Cannot change.`,
            });
          }

          const updateResult = await adoptionRequestsCollection.updateOne(
            { _id: new ObjectId(requestId) },
            { $set: { status: status } }
          );

          if (updateResult.matchedCount === 0) {
            return res.status(404).send({
              message: "Request not found or status already updated.",
            });
          }

          // If accepted, also mark the pet as adopted
          if (status === "accepted") {
            const petUpdateResult = await petsCollection.updateOne(
              { _id: new ObjectId(request.petId) },
              { $set: { adopted: true } }
            );
            if (petUpdateResult.matchedCount === 0) {
              console.warn(
                `Pet ${request.petId} not found when trying to mark as adopted after request acceptance.`
              );
            }
          }

          res.send({
            success: true,
            message: `Adoption request status updated to '${status}'.`,
          });
        } catch (error) {
          console.error("Error updating adoption request status:", error);
          res
            .status(500)
            .send({ message: "Failed to update adoption request status." });
        }
      }
    );

    // Create Stripe Payment Intent (Protected - any logged-in user)
    app.post("/create-payment-intent", verifyFBToken, attachUserRole, async (req, res) => {
      const { amount, campaignId } = req.body;
      const authenticatedUserId = req.decoded.uid; // Get UID from verified Firebase token

      if (!amount || amount <= 0 || !campaignId || !authenticatedUserId) {
        return res.status(400).send({
          message:
            "Amount, campaign ID, and authenticated user ID are required.",
        });
      }
      // Amount must be in cents and integer
      const amountInCents = Math.round(amount * 100);
      if (isNaN(amountInCents) || amountInCents <= 0) {
        return res.status(400).send({ message: "Invalid amount provided." });
      }

      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInCents, // amount in cents
          currency: "usd",
          payment_method_types: ["card"], // Explicitly define payment method types
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

    // Record Donation after successful payment (Protected - any logged-in user)
    app.post("/record-donation", verifyFBToken, attachUserRole, async (req, res) => {
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

    // Get My Donations (Protected - user can only view their own)
    app.get("/my-donations/:userId", verifyFBToken, attachUserRole, async (req, res) => {
      const requestedUserId = req.params.userId;
      const authUserId = req.decoded.uid;

      if (requestedUserId !== authUserId && req.decoded.role !== 'admin') {
        return res.status(403).send({
          message: "Forbidden: You can only view your own donations unless you are an admin.",
        });
      }
      try {
        const donations = await donationsCollection.find({ donorId: requestedUserId }).toArray();
        res.send(donations);
      } catch (error) {
        console.error("Error fetching user's donations:", error);
        res.status(500).send({ message: "Failed to retrieve donations." });
      }
    });






    // --- Adoption Request API Endpoints ---

// Submit an Adoption Request (Protected - by any logged-in user)
app.post("/adoption-requests", verifyFBToken, attachUserRole, async (req, res) => {
  const requestData = req.body;
  const requesterId = req.decoded.uid;

  // Basic validation: ownerId is now optional, but other fields are still required
  if (
    !requestData.petId ||
    !requestData.requesterName ||
    !requestData.requesterEmail ||
    !requestData.requesterPhone ||
    !requestData.requesterLocation ||
    !requestData.petName || // Added validation for petName
    !requestData.petImage // Added validation for petImage
  ) {
    return res
      .status(400)
      .send({ message: "Missing required fields for adoption request." });
  }

  try {
    // Ensure the pet exists and is not already adopted
    const pet = await petsCollection.findOne({
      _id: new ObjectId(requestData.petId),
    });
    if (!pet) {
      return res.status(404).send({ message: "Pet not found." });
    }
    if (pet.adopted) {
      return res
        .status(400)
        .send({ message: "This pet has already been adopted." });
    }

    // IMPORTANT: Modify "Prevent a user from requesting their own pet" check
    // This check now only applies if pet.createdByUserId actually exists on the pet object.
    // If createdByUserId is missing (e.g., for older data), this check is skipped.
    if (pet.createdByUserId && pet.createdByUserId === requesterId) {
      return res
        .status(400)
        .send({ message: "You cannot request to adopt your own pet." });
    }

    // Check if this user has already requested this pet
    const existingRequest = await adoptionRequestsCollection.findOne({
      petId: requestData.petId,
      requesterId: requesterId,
      status: { $in: ["pending", "accepted"] }, // Check for pending or already accepted requests
    });

    if (existingRequest) {
      return res.status(400).send({
        message:
          "You have already submitted an adoption request for this pet.",
      });
    }

    const requestToInsert = {
      ...requestData, // This includes petId, ownerId (can be null), requesterName, etc.
      requesterId: requesterId, // The ID of the user making the request
      requestDate: new Date(), // Store request date
      status: "pending", // Default status
      // petName and petImage are now expected to be in requestData from frontend
      // so no need to derive from `pet` object here.
      // If you want to ensure they are consistent with the DB, you could use:
      // petName: pet.name,
      // petImage: pet.image,
    };

    const result = await adoptionRequestsCollection.insertOne(
      requestToInsert
    );
    res.status(201).send({
      success: true,
      message: "Adoption request submitted successfully!",
      insertedId: result.insertedId,
    });
  } catch (error) {
    console.error("Error submitting adoption request:", error);
    res.status(500).send({ message: "Failed to submit adoption request." });
  }
});

// Get Adoption Requests for Pets Owned by Current User (Protected)
app.get(
  "/owner-adoption-requests/:ownerId",
  verifyFBToken,
  attachUserRole,
  async (req, res) => {
    const requestedOwnerId = req.params.ownerId;
    const authUserId = req.decoded.uid; // User ID from the authenticated token

    // Ensure the requested owner ID matches the authenticated user's ID
    // Or if an admin is requesting
    if (requestedOwnerId !== authUserId && req.decoded.role !== 'admin') {
      return res.status(403).send({
        message: "Forbidden: You can only view requests for your own pets unless you are an admin.",
      });
    }

    try {
      // Find all pets owned by this user
      const ownedPets = await petsCollection
        .find({ createdByUserId: requestedOwnerId })
        .toArray();
      const ownedPetIds = ownedPets.map((pet) => pet._id.toString()); // Get IDs as strings

      // Find adoption requests for these pets
      const requests = await adoptionRequestsCollection
        .find({
          petId: { $in: ownedPetIds }, // Match requests where petId is one of the owned pets
        })
        .toArray();

      res.send(requests);
    } catch (error) {
      console.error("Error fetching owner's adoption requests:", error);
      res
        .status(500)
        .send({ message: "Failed to retrieve adoption requests." });
    }
  }
);

// NEW: Get All Adoption Requests (Admin & Volunteer Only)
app.get(
  "/all-adoption-requests",
  verifyFBToken,
  attachUserRole,
  verifyVolunteer, // Allows both volunteer and admin
  async (req, res) => {
    try {
      const requests = await adoptionRequestsCollection.find().toArray();
      res.send(requests);
    } catch (error) {
      console.error("Error fetching all adoption requests:", error);
      res.status(500).send({ message: "Failed to retrieve all adoption requests." });
    }
  }
);


// Update Adoption Request Status (Accept/Reject) (Protected - by owner, admin, or volunteer)
app.patch(
  "/adoption-requests/status/:id",
  verifyFBToken,
  attachUserRole,
  async (req, res) => {
    const requestId = req.params.id;
    const { status } = req.body; // Expecting { status: 'accepted' | 'rejected' }
    const authUserId = req.decoded.uid;
    const userRole = req.decoded.role;

    if (!ObjectId.isValid(requestId)) {
      return res
        .status(400)
        .send({ message: "Invalid request ID format." });
    }
    if (!["accepted", "rejected"].includes(status)) {
      return res.status(400).send({
        message: "Invalid status. Must be 'accepted' or 'rejected'.",
      });
    }

    try {
      const request = await adoptionRequestsCollection.findOne({
        _id: new ObjectId(requestId),
      });

      if (!request) {
        return res
          .status(404)
          .send({ message: "Adoption request not found." });
      }

      // Verify ownership/permission: Check if the user is the owner of the pet associated with the request
      // OR if the user is an admin OR a volunteer.
      const pet = await petsCollection.findOne({
        _id: new ObjectId(request.petId),
      });

      if (!pet) {
        // If the associated pet is not found, we cannot verify ownership.
        // This might indicate a data inconsistency, but we should still allow admins/volunteers to manage.
        if (userRole !== "admin" && userRole !== "volunteer") {
            return res.status(403).send({
                message: "Forbidden: Associated pet not found and you are not an admin/volunteer."
            });
        }
      } else {
        // If pet is found, check if the current user is the pet owner, admin, or volunteer
        if (pet.createdByUserId !== authUserId && userRole !== "admin" && userRole !== "volunteer") {
          return res.status(403).send({
            message:
              "Forbidden: You do not have permission to update this request.",
          });
        }
      }


      // Only allow status change from 'pending'
      if (request.status !== "pending") {
        return res.status(400).send({
          message: `Request is already ${request.status}. Cannot change.`,
        });
      }

      const updateResult = await adoptionRequestsCollection.updateOne(
        { _id: new ObjectId(requestId) },
        { $set: { status: status } }
      );

      if (updateResult.matchedCount === 0) {
        return res.status(404).send({
          message: "Request not found or status already updated.",
        });
      }

      // If accepted, also mark the pet as adopted
      if (status === "accepted") {
        const petUpdateResult = await petsCollection.updateOne(
          { _id: new ObjectId(request.petId) },
          { $set: { adopted: true } }
        );
        if (petUpdateResult.matchedCount === 0) {
          console.warn(
            `Pet ${request.petId} not found when trying to mark as adopted after request acceptance.`
          );
        }
      }

      res.send({
        success: true,
        message: `Adoption request status updated to '${status}'.`,
      });
    } catch (error) {
      console.error("Error updating adoption request status:", error);
      res
        .status(500)
        .send({ message: "Failed to update adoption request status." });
    }
  }
);













  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close(); // Keep commented out for persistent connection in development
  }
}
run().catch(console.dir);


app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
