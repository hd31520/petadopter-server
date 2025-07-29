require("dotenv").config();
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

try {
  if (!process.env.FB_SERVICE_KEY) {
    throw new Error("FB_SERVICE_KEY environment variable is not set.");
  }
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
  process.exit(1);
}

const uri = process.env.URI;

let db;
let usersCollection;
let petsCollection;
let donationCamCollection;
let donationsCollection;
let wantedPetsCollection;
let adoptionRequestsCollection;
let tasksCollection;

const stripe = require("stripe")(
  process.env.STRIPE_SECRET_KEY || "sk_test_YOUR_STRIPE_SECRET_KEY_FALLBACK"
);

// Helper function to find a document by _id, handling both ObjectId and string IDs
async function findDocumentById(collection, id) {
  let document = null;

  // Try to find by ObjectId first
  if (ObjectId.isValid(id)) {
    try {
      document = await collection.findOne({ _id: new ObjectId(id) });
    } catch (error) {
      // Log a warning but don't fail, as we'll try string next
      console.warn(
        `Warning: Failed to find with ObjectId for ID '${id}' in collection '${collection.collectionName}'. Error: ${error.message}`
      );
    }
  }

  // If not found by ObjectId or if ID was not a valid ObjectId string, try finding by string ID
  if (!document) {
    try {
      document = await collection.findOne({ _id: id });
    } catch (error) {
      console.error(
        `Error finding document with ID '${id}' as string in collection '${collection.collectionName}'. Error: ${error.message}`
      );
    }
  }

  return document;
}

async function run() {
  if (!uri) {
    console.error("Error: MONGODB_URI is not defined in your .env file.");
    console.error(
      "Please make sure your .env file is in the root of your project and contains MONGODB_URI='YOUR_CONNECTION_STRING'"
    );
    process.exit(1);
  }

  try {
    const client = new MongoClient(uri, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
    });

    await client.connect();
    console.log("Connected to MongoDB successfully!");

    db = client.db("adopty");
    usersCollection = db.collection("users");
    petsCollection = db.collection("pets");
    donationCamCollection = db.collection("donation-cam");
    donationsCollection = db.collection("donations");
    wantedPetsCollection = db.collection("wantedPets");
    adoptionRequestsCollection = db.collection("adoptionRequests");
    tasksCollection = db.collection("tasks");

    const userCount = await usersCollection.countDocuments();
    const petCount = await petsCollection.countDocuments();
    const campaignCount = await donationCamCollection.countDocuments();
    const donationCount = await donationsCollection.countDocuments();
    const wantedPetCount = await wantedPetsCollection.countDocuments();
    const taskCount = await tasksCollection.countDocuments();

    console.log(`Users in DB: ${userCount}`);
    console.log(`Pets in DB: ${petCount}`);
    console.log(`Donation Campaigns in DB: ${campaignCount}`);
    console.log(`Donations in DB: ${donationCount}`);
    console.log(`Wanted Pet Requests in DB: ${wantedPetCount}`);
    console.log(`Tasks in DB: ${taskCount}`);

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
        req.decoded = decodedToken;
        next();
      } catch (error) {
        console.error("Firebase token verification error:", error);
        return res
          .status(403)
          .send({ message: "Forbidden: Invalid or expired token" });
      }
    };

    const attachUserRole = async (req, res, next) => {
      if (!req.decoded || !req.decoded.email || !req.decoded.uid) {
        return res
          .status(401)
          .send({
            message: "Unauthorized: User email or UID not found in token.",
          });
      }
      try {
        // Find user by email (as per original route structure)
        const user = await usersCollection.findOne({
          email: req.decoded.email,
        });
        if (user) {
          req.decoded.role = user.role;
        } else {
          req.decoded.role = "user";
          // If user not found in DB but authenticated via Firebase, create a basic entry
          // This ensures a role is always available for authenticated users
          await usersCollection.insertOne({
            email: req.decoded.email,
            uid: req.decoded.uid, // Store Firebase UID
            displayName: req.decoded.name || req.decoded.email,
            photoURL: req.decoded.picture || null,
            role: "user",
            createdAt: new Date().toISOString(),
            last_log_in: new Date().toISOString(),
          });
        }
        next();
      } catch (error) {
        console.error("Error attaching user role:", error);
        res
          .status(500)
          .send({ message: "Internal server error during role attachment." });
      }
    };

    const verifyAdmin = (req, res, next) => {
      if (!req.decoded || req.decoded.role !== "admin") {
        return res
          .status(403)
          .send({ message: "Forbidden: Admin access required." });
      }
      next();
    };

    const verifyVolunteer = (req, res, next) => {
      if (
        !req.decoded ||
        (req.decoded.role !== "volunteer" && req.decoded.role !== "admin")
      ) {
        return res
          .status(403)
          .send({ message: "Forbidden: Volunteer or Admin access required." });
      }
      next();
    };

    app.get("/", (req, res) => {
      res.send("Adopty Backend is running!");
    });

    app.post("/users", async (req, res) => {
      const user = req.body;
      const email = user.email;
      const uid = user.uid; // Expect Firebase UID from frontend

      if (!email || !uid) {
        return res.status(400).send({ message: "Email and UID are required." });
      }

      try {
        const userExists = await usersCollection.findOne({ email }); // Find by email

        if (userExists) {
          const updateDoc = {
            $set: {
              last_log_in: user.last_log_in || new Date().toISOString(),
              displayName: user.displayName || userExists.displayName,
              photoURL: user.photoURL || userExists.photoURL,
              uid: uid, // Ensure UID is updated/added if missing
            },
          };
          await usersCollection.updateOne({ email }, updateDoc);
          return res.status(200).send({
            message: "User already exists. Last login updated.",
            inserted: false,
            user: { ...userExists, ...user },
          });
        }

        const newUser = {
          ...user,
          uid: uid, // Store Firebase UID
          role: user.role || "user",
          createdAt: new Date().toISOString(),
          last_log_in: new Date().toISOString(),
        };
        const result = await usersCollection.insertOne(newUser);
        res.status(201).send({ ...result, user: newUser });
      } catch (error) {
        console.error("Error processing user:", error);
        res.status(500).send({ message: "Failed to process user data." });
      }
    });

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

    app.get(
      "/users/:email", // Route parameter remains :email
      verifyFBToken,
      attachUserRole,
      async (req, res) => {
        const requestedEmail = req.params.email;
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
          const user = await usersCollection.findOne({ email: requestedEmail }); // Query by email
          if (user) {
            res.send(user);
          } else {
            res.status(404).send({ message: "User not found." });
          }
        } catch (error) {
          console.error("Error fetching user:", error);
          res.status(500).send({ message: "Failed to retrieve user." });
        }
      }
    );

    app.patch(
      "/users/role/:id", // Route parameter remains :id (MongoDB _id)
      verifyFBToken,
      attachUserRole,
      verifyAdmin,
      async (req, res) => {
        const userId = req.params.id; // This is MongoDB _id

        if (!["admin", "volunteer", "user"].includes(req.body.role)) {
          return res.status(400).send({ message: "Invalid role specified." });
        }

        try {
          const userToUpdate = await findDocumentById(usersCollection, userId); // Use helper
          if (!userToUpdate) {
            return res.status(404).send({ message: "User not found." });
          }

          const result = await usersCollection.updateOne(
            { _id: userToUpdate._id }, // Use found _id
            { $set: { role: req.body.role } }
          );

          if (result.matchedCount === 0) {
            return res
              .status(404)
              .send({ message: "User not found or role already updated." });
          }
          res.send({
            success: true,
            message: `User role updated to ${req.body.role}.`,
          });
        } catch (error) {
          console.error("Error updating user role:", error);
          res.status(500).send({ message: "Failed to update user role." });
        }
      }
    );

    app.delete(
      "/users/:id", // Route parameter remains :id (MongoDB _id)
      verifyFBToken,
      attachUserRole,
      verifyAdmin,
      async (req, res) => {
        const userId = req.params.id; // This is MongoDB _id

        try {
          const userToDelete = await findDocumentById(usersCollection, userId); // Use helper
          if (!userToDelete) {
            return res.status(404).send({ message: "User not found." });
          }

          const result = await usersCollection.deleteOne({
            _id: userToDelete._id, // Use found _id
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

    app.get("/pets", async (req, res) => {
      try {
        const result = await petsCollection.find().toArray();
        res.send(result);
      } catch (error) {
        console.error("Error fetching pets:", error);
        res.status(500).send({ message: "Internal server error." });
      }
    });

    app.get("/pets/:id", async (req, res) => {
      const petId = req.params.id;

      try {
        const pet = await findDocumentById(petsCollection, petId);
        if (!pet) {
          return res.status(404).send({ message: "Pet not found." });
        }
        res.send(pet);
      } catch (error) {
        console.error("Error fetching single pet:", error);
        res.status(500).send({ message: "Failed to retrieve pet." });
      }
    });

    app.post("/pets", verifyFBToken, attachUserRole, async (req, res) => {
      const newPetData = req.body;
      const creatorId = req.decoded.uid; // Firebase UID (string)

      if (
        !newPetData.name ||
        !newPetData.image ||
        !newPetData.category ||
        !newPetData.petLocation ||
        !newPetData.breed ||
        !newPetData.description ||
        !creatorId
      ) {
        return res.status(400).send({
          message:
            "Missing required pet fields: name, image, category, location, breed, description.",
        });
      }

      try {
        const petToInsert = {
          name: newPetData.name,
          image: newPetData.image,
          category: newPetData.category,
          breed: newPetData.breed,
          description: newPetData.description,
          petLocation: newPetData.petLocation,
          age: newPetData.age || "N/A",
          createdByUserId: creatorId, // Store Firebase UID (string)
          createdAt: new Date(),
          adopted: false,
        };

        let insertedId;

        if (newPetData._id) {
          if (typeof newPetData._id !== "string") {
            return res
              .status(400)
              .send({ message: "Provided _id must be a string." });
          }

          const existingPet = await petsCollection.findOne({
            _id: newPetData._id,
          });
          if (existingPet) {
            return res
              .status(409)
              .send({
                message: `A pet with ID '${newPetData._id}' already exists.`,
              });
          }

          petToInsert._id = newPetData._id;
          const result = await petsCollection.insertOne(petToInsert);
          insertedId = result.insertedId;
          console.log(`Inserted pet with custom string ID: ${insertedId}`);
        } else {
          const result = await petsCollection.insertOne(petToInsert);
          insertedId = result.insertedId;
          console.log(
            `Inserted pet with auto-generated ObjectId: ${insertedId}`
          );
        }

        res.status(201).send({
          success: true,
          message: "Pet added successfully!",
          insertedId: insertedId,
        });
      } catch (error) {
        if (error.code === 11000 && error.keyPattern && error.keyPattern._id) {
          return res
            .status(409)
            .send({ message: "A pet with this ID already exists." });
        }
        console.error("Error adding new pet:", error);
        res.status(500).send({ message: "Failed to add pet." });
      }
    });

    app.get(
      "/user-pets/:userId", // userId here is Firebase UID (string)
      verifyFBToken,
      attachUserRole,
      async (req, res) => {
        const requestedUserId = req.params.userId; // Firebase UID (string)
        const authUserId = req.decoded.uid; // User ID from the authenticated token
        const userRole = req.decoded.role;

        if (requestedUserId !== authUserId && userRole !== "admin") {
          return res.status(403).send({
            message:
              "Forbidden: You can only view your own added pets unless you are an admin.",
          });
        }

        try {
          const pets = await petsCollection
            .find({ createdByUserId: requestedUserId }) // Query by Firebase UID (string)
            .toArray();
          res.send(pets);
        } catch (error) {
          console.error("Error fetching user's pets:", error);
          res.status(500).send({ message: "Failed to retrieve pets." });
        }
      }
    );

    app.delete("/pets/:id", verifyFBToken, attachUserRole, async (req, res) => {
      const petId = req.params.id;

      try {
        const pet = await findDocumentById(petsCollection, petId);
        if (!pet) {
          return res.status(404).send({ message: "Pet not found." });
        }

        if (
          pet.createdByUserId !== req.decoded.uid &&
          req.decoded.role !== "admin"
        ) {
          return res.status(403).send({
            message:
              "Forbidden: You do not have permission to delete this pet.",
          });
        }

        const result = await petsCollection.deleteOne({
          _id: pet._id, // Use the found _id (ObjectId or string)
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

    app.patch(
      "/pets/status/:id",
      verifyFBToken,
      attachUserRole,
      async (req, res) => {
        const petId = req.params.id;
        const { adopted } = req.body;

        if (typeof adopted !== "boolean") {
          return res.status(400).send({
            message: "Invalid 'adopted' status. Must be true or false.",
          });
        }

        try {
          const pet = await findDocumentById(petsCollection, petId);
          if (!pet) {
            return res.status(404).send({ message: "Pet not found." });
          }

          if (
            pet.createdByUserId !== req.decoded.uid &&
            req.decoded.role !== "admin"
          ) {
            return res.status(403).send({
              message:
                "Forbidden: You do not have permission to update this pet status.",
            });
          }

          if (pet.adopted === adopted) {
            return res.status(200).send({
              success: false,
              message: "Pet status is already as requested.",
            });
          }

          const result = await petsCollection.updateOne(
            { _id: pet._id }, // Use the found _id (ObjectId or string)
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

    app.patch("/pets/:id", verifyFBToken, attachUserRole, async (req, res) => {
      const petId = req.params.id;
      const updatedPetData = req.body;

      try {
        const pet = await findDocumentById(petsCollection, petId);
        if (!pet) {
          return res.status(404).send({ message: "Pet not found." });
        }

        if (
          pet.createdByUserId !== req.decoded.uid &&
          req.decoded.role !== "admin"
        ) {
          return res.status(403).send({
            message:
              "Forbidden: You do not have permission to update this pet.",
          });
        }

        const updateDoc = {};

        if (updatedPetData.petName !== undefined) {
          updateDoc.name = updatedPetData.petName;
        } else if (updatedPetData.name !== undefined) {
          updateDoc.name = updatedPetData.name;
        }

        if (updatedPetData.petImage !== undefined) {
          updateDoc.image = updatedPetData.petImage;
        } else if (updatedPetData.image !== undefined) {
          updateDoc.image = updatedPetData.image;
        }

        if (updatedPetData.petCategory !== undefined) {
          updateDoc.category = updatedPetData.petCategory;
        } else if (updatedPetData.category !== undefined) {
          updateDoc.category = updatedPetData.category;
        }

        let ageValue;
        if (updatedPetData.petAge !== undefined) {
          ageValue = updatedPetData.petAge;
        } else if (updatedPetData.age !== undefined) {
          ageValue = updatedPetData.age;
        }

        if (ageValue !== undefined) {
          const parsedAge = parseInt(ageValue);
          if (isNaN(parsedAge) || parsedAge < 0) {
            return res
              .status(400)
              .send({ message: "Pet age must be a non-negative number." });
          }
          updateDoc.age = parsedAge;
        }

        const allowedFields = [
          "petLocation",
          "shortDescription",
          "longDescription",
          "breed",
        ];

        allowedFields.forEach((field) => {
          if (updatedPetData[field] !== undefined) {
            updateDoc[field] = updatedPetData[field];
          }
        });

        if (Object.keys(updateDoc).length === 0) {
          return res
            .status(400)
            .send({ message: "No valid fields provided for update." });
        }

        const result = await petsCollection.updateOne(
          { _id: pet._id }, // Use the found _id (ObjectId or string)
          { $set: updateDoc }
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

    app.get("/donation-cam", async (req, res) => {
      try {
        const result = await donationCamCollection.find().toArray();
        res.send(result);
      } catch (error) {
        console.error("Error fetching all donation campaigns:", error);
        res.status(500).send({ message: "Internal server error." });
      }
    });

    app.get("/donation-cam/:id", async (req, res) => {
      const campaignId = req.params.id;

      try {
        const campaign = await findDocumentById(
          donationCamCollection,
          campaignId
        );
        if (!campaign) {
          return res
            .status(404)
            .send({ message: "Donation campaign not found." });
        }
        res.send(campaign);
      } catch (error) {
        console.error("Error fetching single donation campaign:", error);
        res.status(500).send({ message: "Internal server error." });
      }
    });

    app.get("/recommended-campaigns/:excludeId", async (req, res) => {
      const excludeId = req.params.excludeId;
      const limit = parseInt(req.query.limit) || 3;

      try {
        let query = {};
        // Use findDocumentById to get the correct _id type for exclusion
        const excludeCampaign = await findDocumentById(
          donationCamCollection,
          excludeId
        );
        if (excludeCampaign) {
          query = { _id: { $ne: excludeCampaign._id } };
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

    app.post(
      "/donation-cam",
      verifyFBToken,
      attachUserRole,
      async (req, res) => {
        const newCampaign = req.body;
        const creatorId = req.decoded.uid;

        if (
          !newCampaign.petName ||
          !newCampaign.targetAmount ||
          !newCampaign.category ||
          !newCampaign.endDate ||
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

        const endDate = new Date(newCampaign.endDate);
        if (isNaN(endDate.getTime())) {
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
            createdByUserId: creatorId,
            createdAt: new Date(),
            donatedAmount: 0,
            donorCount: 0,
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

    app.patch(
      "/donation-cam/:id",
      verifyFBToken,
      attachUserRole,
      async (req, res) => {
        const campaignId = req.params.id;
        const updatedCampaignData = req.body;

        try {
          const campaign = await findDocumentById(
            donationCamCollection,
            campaignId
          );
          if (!campaign) {
            return res
              .status(404)
              .send({ message: "Donation campaign not found." });
          }

          if (
            campaign.createdByUserId !== req.decoded.uid &&
            req.decoded.role !== "admin"
          ) {
            return res.status(403).send({
              message:
                "Forbidden: You do not have permission to update this campaign.",
            });
          }

          const {
            _id,
            createdByUserId,
            createdAt,
            donatedAmount,
            donorCount,
            ...dataToUpdate
          } = updatedCampaignData;

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
              if (campaign.donatedAmount < campaign.targetAmount) {
                return res.status(400).send({
                  message:
                    "Cannot set end date to past if campaign is not fully funded.",
                });
              }
            }
          }

          if (Object.keys(dataToUpdate).length === 0) {
            return res
              .status(400)
              .send({ message: "No valid fields provided for update." });
          }

          const result = await donationCamCollection.updateOne(
            { _id: campaign._id }, // Use the found _id (ObjectId or string)
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

    app.patch(
      "/donation-cam/status/:id",
      verifyFBToken,
      attachUserRole,
      async (req, res) => {
        const campaignId = req.params.id;
        const { paused } = req.body;

        try {
          const campaign = await findDocumentById(
            donationCamCollection,
            campaignId
          );
          if (!campaign) {
            return res
              .status(404)
              .send({ message: "Donation campaign not found." });
          }

          if (
            campaign.createdByUserId !== req.decoded.uid &&
            req.decoded.role !== "admin"
          ) {
            return res.status(403).send({
              message:
                "Forbidden: You do not have permission to change this campaign's status.",
            });
          }

          if (campaign.paused === paused) {
            return res
              .status(200)
              .send({
                success: false,
                message: "Campaign status is already as requested.",
              });
          }

          const result = await donationCamCollection.updateOne(
            { _id: campaign._id }, // Use the found _id (ObjectId or string)
            { $set: { paused: paused } }
          );

          if (result.matchedCount === 0) {
            return res
              .status(404)
              .send({
                message: "Campaign not found or status already updated.",
              });
          }
          res.send({
            success: true,
            message: `Campaign status updated to paused: ${paused}.`,
          });
        } catch (error) {
          console.error("Error updating campaign status:", error);
          res
            .status(500)
            .send({ message: "Failed to update campaign status." });
        }
      }
    );

    app.delete(
      "/donation-cam/:id",
      verifyFBToken,
      attachUserRole,
      async (req, res) => {
        const campaignId = req.params.id;

        try {
          const campaign = await findDocumentById(
            donationCamCollection,
            campaignId
          );
          if (!campaign) {
            return res
              .status(404)
              .send({ message: "Donation campaign not found." });
          }

          if (
            campaign.createdByUserId !== req.decoded.uid &&
            req.decoded.role !== "admin"
          ) {
            return res.status(403).send({
              message:
                "Forbidden: You do not have permission to delete this campaign.",
            });
          }

          const result = await donationCamCollection.deleteOne({
            _id: campaign._id, // Use the found _id (ObjectId or string)
          });

          if (result.deletedCount === 1) {
            res.send({
              success: true,
              message: "Campaign deleted successfully.",
            });
          } else {
            res
              .status(404)
              .send({ message: "Campaign not found or already deleted." });
          }
        } catch (error) {
          console.error("Error deleting campaign:", error);
          res.status(500).send({ message: "Failed to delete campaign." });
        }
      }
    );

    app.post(
      "/create-payment-intent",
      verifyFBToken,
      attachUserRole,
      async (req, res) => {
        const { amount, campaignId } = req.body;
        const authenticatedUserId = req.decoded.uid;

        if (!amount || amount <= 0 || !campaignId || !authenticatedUserId) {
          return res.status(400).send({
            message:
              "Amount, campaign ID, and authenticated user ID are required.",
          });
        }
        const amountInCents = Math.round(amount * 100);
        if (isNaN(amountInCents) || amountInCents <= 0) {
          return res.status(400).send({ message: "Invalid amount provided." });
        }

        try {
          const paymentIntent = await stripe.paymentIntents.create({
            amount: amountInCents,
            currency: "usd",
            payment_method_types: ["card"],
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
      }
    );

    app.post(
      "/record-donation",
      verifyFBToken,
      attachUserRole,
      async (req, res) => {
        const { campaignId, amount, paymentIntentId } = req.body;
        const authenticatedDonorId = req.decoded.uid;
        const authenticatedDonorName = req.decoded.name || req.decoded.email;
        const authenticatedDonorEmail = req.decoded.email;

        if (
          !campaignId ||
          !amount ||
          !authenticatedDonorId ||
          !paymentIntentId
        ) {
          return res.status(400).send({
            message:
              "Missing required donation details for authenticated user.",
          });
        }

        try {
          const campaign = await findDocumentById(
            donationCamCollection,
            campaignId
          );
          if (!campaign) {
            return res
              .status(404)
              .send({ message: "Donation campaign not found." });
          }

          const updateResult = await donationCamCollection.updateOne(
            { _id: campaign._id }, // Use the found _id (ObjectId or string)
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
            campaignId: campaign._id, // Use the found _id (ObjectId or string)
            amount: amount,
            donorId: authenticatedDonorId,
            donorName: authenticatedDonorName,
            donorEmail: authenticatedDonorEmail,
            paymentIntentId: paymentIntentId,
            donationDate: new Date(),
          };
          await donationsCollection.insertOne(donationRecord);

          res.send({
            success: true,
            message: "Donation recorded successfully!",
          });
        } catch (error) {
          console.error("Error recording donation:", error);
          res.status(500).send({
            success: false,
            message: "Internal server error during donation recording.",
          });
        }
      }
    );

    app.get(
      "/my-donations/:userId", // userId here is Firebase UID (string)
      verifyFBToken,
      attachUserRole,
      async (req, res) => {
        const requestedUserId = req.params.userId; // Firebase UID (string)
        const authUserId = req.decoded.uid;

        if (requestedUserId !== authUserId && req.decoded.role !== "admin") {
          return res.status(403).send({
            message:
              "Forbidden: You can only view your own donations unless you are an admin.",
          });
        }
        try {
          const donations = await donationsCollection
            .find({ donorId: requestedUserId }) // Query by Firebase UID (string)
            .toArray();
          res.send(donations);
        } catch (error) {
          console.error("Error fetching user's donations:", error);
          res.status(500).send({ message: "Failed to retrieve donations." });
        }
      }
    );

    app.get(
      "/all-donations",
      verifyFBToken,
      attachUserRole,
      verifyAdmin,
      async (req, res) => {
        try {
          const donations = await donationsCollection.find().toArray();
          console.log(donations);
          res.send(donations);
        } catch (error) {
          console.error("Error fetching all donations:", error);
          res.status(500).send({ message: "Failed to retrieve donations." });
        }
      }
    );

    app.get(
      "/my-donation-campaigns/:userId", // userId here is Firebase UID (string)
      verifyFBToken,
      attachUserRole,
      async (req, res) => {
        const requestedUserId = req.params.userId; // Firebase UID (string)
        const authUserId = req.decoded.uid;

        if (requestedUserId !== authUserId && req.decoded.role !== "admin") {
          return res.status(403).send({
            message:
              "Forbidden: You can only view your own campaigns unless you are an admin.",
          });
        }
        try {
          const campaigns = await donationCamCollection
            .find({ createdByUserId: requestedUserId }) // Query by Firebase UID (string)
            .toArray();
          res.send(campaigns);
        } catch (error) {
          console.error("Error fetching user's donation campaigns:", error);
          res.status(500).send({ message: "Failed to retrieve campaigns." });
        }
      }
    );

    app.post(
      "/tasks",
      verifyFBToken,
      attachUserRole,
      verifyVolunteer,
      async (req, res) => {
        const { title, description, priority, dueDate, assignedTo } = req.body;
        const assignedBy = req.decoded.uid; // Firebase UID (string)

        if (!title || !description || !priority || !assignedTo) {
          return res
            .status(400)
            .send({ message: "Missing required task fields" });
        }

        try {
          // Check if assignedTo user exists and is a volunteer (query by UID)
          const userExists = await usersCollection.findOne({
            uid: assignedTo, // Query by Firebase UID (string)
            role: "volunteer",
          });

          if (!userExists) {
            return res.status(404).send({ message: "Volunteer not found" });
          }

          const newTask = {
            title,
            description,
            status: "pending",
            priority,
            dueDate: dueDate ? new Date(dueDate) : null,
            assignedTo: assignedTo, // Store Firebase UID (string)
            assignedBy: assignedBy, // Store Firebase UID (string)
            createdAt: new Date(),
            updatedAt: new Date(),
          };

          const result = await tasksCollection.insertOne(newTask);
          res.status(201).send({
            success: true,
            message: "Task created successfully",
            taskId: result.insertedId,
          });
        } catch (error) {
          console.error("Error creating task:", error);
          res.status(500).send({ message: "Failed to create task" });
        }
      }
    );

    app.get(
      "/tasks",
      verifyFBToken,
      attachUserRole,
      verifyVolunteer,
      async (req, res) => {
        try {
          const tasks = await tasksCollection
            .aggregate([
              {
                $lookup: {
                  from: "users",
                  localField: "assignedTo", // This is Firebase UID (string)
                  foreignField: "uid", // Link to 'uid' field in users collection
                  as: "assignedToUser",
                },
              },
              {
                $lookup: {
                  from: "users",
                  localField: "assignedBy", // This is Firebase UID (string)
                  foreignField: "uid", // Link to 'uid' field in users collection
                  as: "assignedByUser",
                },
              },
              {
                $unwind: {
                  path: "$assignedToUser",
                  preserveNullAndEmptyArrays: true,
                }, // Preserve tasks even if user not found
              },
              {
                $unwind: {
                  path: "$assignedByUser",
                  preserveNullAndEmptyArrays: true,
                }, // Preserve tasks even if user not found
              },
              {
                $sort: { createdAt: -1 },
              },
            ])
            .toArray();

          res.send(tasks);
        } catch (error) {
          console.error("Error fetching tasks:", error);
          res.status(500).send({ message: "Failed to fetch tasks" });
        }
      }
    );

    app.get("/my-tasks", verifyFBToken, attachUserRole, async (req, res) => {
      try {
        const tasks = await tasksCollection
          .aggregate([
            {
              $match: { assignedTo: req.decoded.uid }, // Match by Firebase UID (string)
            },
            {
              $lookup: {
                from: "users",
                localField: "assignedBy", // This is Firebase UID (string)
                foreignField: "uid", // Link to 'uid' field in users collection
                as: "assignedByUser",
              },
            },
            {
              $unwind: {
                path: "$assignedByUser",
                preserveNullAndEmptyArrays: true,
              }, // Preserve tasks even if user not found
            },
            {
              $sort: { createdAt: -1 },
            },
          ])
          .toArray();

        res.send(tasks);
      } catch (error) {
        console.error("Error fetching user tasks:", error);
        res.status(500).send({ message: "Failed to fetch your tasks" });
      }
    });

    app.patch(
      "/tasks/:id/status",
      verifyFBToken,
      attachUserRole,
      async (req, res) => {
        const taskId = req.params.id;
        const { status } = req.body;
        const userId = req.decoded.uid; // Firebase UID (string)

        if (!["pending", "in-progress", "completed"].includes(status)) {
          return res.status(400).send({ message: "Invalid status" });
        }

        try {
          const task = await findDocumentById(tasksCollection, taskId);
          if (!task) {
            return res.status(404).send({ message: "Task not found" });
          }

          if (task.assignedTo !== userId) {
            // Compare Firebase UID strings
            return res
              .status(403)
              .send({ message: "Not authorized to update this task" });
          }

          const result = await tasksCollection.updateOne(
            { _id: task._id }, // Use the found _id (ObjectId or string)
            { $set: { status, updatedAt: new Date() } }
          );

          if (result.matchedCount === 0) {
            return res
              .status(404)
              .send({ message: "Task not found or status already updated." });
          }

          res.send({ success: true, message: "Task status updated" });
        } catch (error) {
          console.error("Error updating task status:", error);
          res.status(500).send({ message: "Failed to update task status" });
        }
      }
    );

    app.patch(
      "/tasks/:id",
      verifyFBToken,
      attachUserRole,
      verifyVolunteer,
      async (req, res) => {
        const taskId = req.params.id;
        const { title, description, priority, dueDate, assignedTo } = req.body;
        const userId = req.decoded.uid; // Firebase UID (string)

        try {
          const existingTask = await findDocumentById(tasksCollection, taskId);
          if (!existingTask) {
            return res.status(404).send({ message: "Task not found" });
          }

          if (
            existingTask.assignedBy !== userId && // Compare Firebase UID strings
            req.decoded.role !== "admin"
          ) {
            return res
              .status(403)
              .send({ message: "Not authorized to update this task" });
          }

          const updateFields = { updatedAt: new Date() };
          if (title) updateFields.title = title;
          if (description) updateFields.description = description;
          if (priority) updateFields.priority = priority;
          if (dueDate) updateFields.dueDate = new Date(dueDate);

          if (assignedTo) {
            const userExists = await usersCollection.findOne({
              uid: assignedTo, // Query by Firebase UID (string)
              role: "volunteer",
            });
            if (!userExists) {
              return res.status(404).send({ message: "Volunteer not found" });
            }
            updateFields.assignedTo = assignedTo; // Store Firebase UID (string)
          }

          const result = await tasksCollection.updateOne(
            { _id: existingTask._id }, // Use the found _id (ObjectId or string)
            { $set: updateFields }
          );

          if (result.matchedCount === 0) {
            return res
              .status(404)
              .send({ message: "Task not found or no changes made." });
          }

          res.send({ success: true, message: "Task updated successfully" });
        } catch (error) {
          console.error("Error updating task:", error);
          res.status(500).send({ message: "Failed to update task" });
        }
      }
    );

    app.delete(
      "/tasks/:id",
      verifyFBToken,
      attachUserRole,
      verifyVolunteer,
      async (req, res) => {
        const taskId = req.params.id;
        const userId = req.decoded.uid; // Firebase UID (string)

        try {
          const existingTask = await findDocumentById(tasksCollection, taskId);
          if (!existingTask) {
            return res.status(404).send({ message: "Task not found" });
          }

          if (
            existingTask.assignedBy !== userId && // Compare Firebase UID strings
            req.decoded.role !== "admin"
          ) {
            return res
              .status(403)
              .send({ message: "Not authorized to delete this task" });
          }

          const result = await tasksCollection.deleteOne({
            _id: existingTask._id, // Use the found _id (ObjectId or string)
          });

          if (result.deletedCount === 0) {
            return res
              .status(404)
              .send({ message: "Task not found or already deleted." });
          }

          res.send({ success: true, message: "Task deleted successfully" });
        } catch (error) {
          console.error("Error deleting task:", error);
          res.status(500).send({ message: "Failed to delete task" });
        }
      }
    );

    app.get(
      "/task-stats",
      verifyFBToken,
      attachUserRole,
      verifyVolunteer,
      async (req, res) => {
        try {
          const stats = await tasksCollection
            .aggregate([
              {
                $group: {
                  _id: "$status",
                  count: { $sum: 1 },
                },
              },
              {
                $project: {
                  status: "$_id",
                  count: 1,
                  _id: 0,
                },
              },
            ])
            .toArray();

          res.send(stats);
        } catch (error) {
          console.error("Error fetching task stats:", error);
          res.status(500).send({ message: "Failed to fetch task statistics" });
        }
      }
    );

    app.get(
      "/all-adoption-requests",
      verifyFBToken,
      attachUserRole,
      verifyAdmin,
      async (req, res) => {
        try {
          const requests = await adoptionRequestsCollection
            .aggregate([
              {
                $lookup: {
                  from: "pets",
                  localField: "petId", // Can be ObjectId or string
                  foreignField: "_id", // Can be ObjectId or string
                  as: "petDetails",
                },
              },
              {
                $unwind: {
                  path: "$petDetails",
                  preserveNullAndEmptyArrays: true,
                }, // Preserve requests if pet not found
              },
              {
                $sort: { requestDate: -1 },
              },
            ])
            .toArray();

          res.send(requests);
        } catch (error) {
          console.error("Error fetching all adoption requests:", error);
          res
            .status(500)
            .send({ message: "Failed to retrieve all adoption requests." });
        }
      }
    );

    app.get(
      "/owner-adoption-requests/:ownerId", // ownerId is Firebase UID (string)
      verifyFBToken,
      attachUserRole,
      async (req, res) => {
        const requestedOwnerId = req.params.ownerId; // Firebase UID (string)
        const authUserId = req.decoded.uid;
        const userRole = req.decoded.role;

        if (requestedOwnerId !== authUserId && userRole !== "admin") {
          return res.status(403).send({
            message:
              "Forbidden: You can only view requests for your own pets unless you are an admin.",
          });
        }

        try {
          // Find all pets owned by this user (createdByUserId is Firebase UID string)
          const ownedPets = await petsCollection
            .find({
              createdByUserId: requestedOwnerId,
            })
            .toArray();

          if (ownedPets.length === 0) {
            return res.status(200).send([]);
          }

          // Get the actual _id values (ObjectId objects or strings) of these owned pets
          const ownedPetIds = ownedPets.map((pet) => pet._id);

          // Find adoption requests where petId matches these _id values
          const requests = await adoptionRequestsCollection
            .find({
              petId: { $in: ownedPetIds }, // Use actual _id types for $in query
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
    app.post(
      "/adoption-requests",
      verifyFBToken, // Middleware to verify Firebase token and attach decoded data (e.g., uid) to req.decoded
      attachUserRole, // Middleware to attach user role if needed
      async (req, res) => {
        // Extract request data from the request body
        const requestData = req.body;
        // Get the requester's user ID from the decoded Firebase token
        const requesterId = req.decoded.uid;

        // Basic validation: Check for required fields from the frontend
        if (
          !requestData.petId ||
          !requestData.requesterName ||
          !requestData.requesterEmail ||
          !requestData.requesterPhone ||
          !requestData.requesterLocation
        ) {
          return res.status(400).send({
            message:
              "Missing required fields for adoption request (petId, requesterName, requesterEmail, requesterPhone, requesterLocation).",
          });
        }

        try {
          // Fetch pet details using the provided petId.
          // The findDocumentById helper should handle converting requestData.petId (string)
          // to a proper MongoDB ObjectId for the query if _id is of ObjectId type.
          const pet = await findDocumentById(petsCollection, requestData.petId);

          // If the pet is not found, return a 404 error
          if (!pet) {
            return res.status(404).send({ message: "Pet not found." });
          }

          // If the pet is already adopted, prevent further requests
          if (pet.adopted) {
            return res
              .status(400)
              .send({ message: "This pet has already been adopted." });
          }

          // Prevent a user from requesting to adopt their own pet
          // Check if pet.createdByUserId exists to avoid errors if the field is missing
          if (pet.createdByUserId && pet.createdByUserId === requesterId) {
            return res
              .status(400)
              .send({ message: "You cannot request to adopt your own pet." });
          }

          // Check if this user has already submitted an adoption request for this specific pet.
          // We use pet._id (the actual BSON ObjectId from the fetched pet document)
          // for consistency and correctness in the query.
          const existingRequest = await adoptionRequestsCollection.findOne({
            petId: pet._id, // Use the BSON ObjectId of the pet
            requesterId: requesterId,
            // Check for existing pending or already accepted requests
            status: { $in: ["pending", "accepted"] },
          });

          // If an existing request is found, prevent duplicate submissions
          if (existingRequest) {
            return res.status(400).send({
              message:
                "You have already submitted an adoption request for this pet.",
            });
          }

          // Construct the adoption request object to be inserted into the database
          const requestToInsert = {
            petId: pet._id, // Use the BSON ObjectId of the pet for consistency
            petName: pet.name, // Derive pet name from the fetched pet document
            petImage: pet.image, // Derive pet image from the fetched pet document
            ownerId: pet.createdByUserId, // Derive owner ID from the fetched pet document
            requesterId: requesterId, // The ID of the user submitting the request
            requesterName: requestData.requesterName,
            requesterEmail: requestData.requesterEmail,
            requesterPhone: requestData.requesterPhone,
            requesterLocation: requestData.requesterLocation,
            // Include requesterMessage if provided, it's an optional field
            requesterMessage: requestData.requesterMessage || "",
            requestDate: new Date(), // Timestamp of the request submission
            status: "pending", // Default status for a new request
          };

          // Insert the new adoption request into the collection
          const result = await adoptionRequestsCollection.insertOne(
            requestToInsert
          );

          // Send a success response with the inserted ID
          res.status(201).send({
            success: true,
            message: "Adoption request submitted successfully!",
            insertedId: result.insertedId,
          });
        } catch (error) {
          // Log any errors that occur during the process
          console.error("Error submitting adoption request:", error);
          // Send a 500 internal server error response
          res
            .status(500)
            .send({ message: "Failed to submit adoption request." });
        }
      }
    );

    app.patch(
      "/adoption-requests/status/:id", // id is MongoDB _id for the request
      verifyFBToken,
      attachUserRole,
      async (req, res) => {
        const requestId = req.params.id;
        const { status } = req.body;

        if (!["accepted", "rejected"].includes(status)) {
          return res.status(400).send({
            message: "Invalid status. Must be 'accepted' or 'rejected'.",
          });
        }

        try {
          const request = await findDocumentById(
            adoptionRequestsCollection,
            requestId
          );
          if (!request) {
            return res
              .status(404)
              .send({ message: "Adoption request not found." });
          }

          if (request.status !== "pending") {
            return res.status(400).send({
              message: `Request is already ${request.status}. Cannot change.`,
            });
          }

          const pet = await findDocumentById(petsCollection, request.petId); // request.petId can be ObjectId or string

          if (!pet) {
            // If associated pet not found, allow admin/volunteer to manage, otherwise deny
            if (
              req.decoded.role !== "admin" &&
              req.decoded.role !== "volunteer"
            ) {
              return res.status(403).send({
                message:
                  "Forbidden: Associated pet not found and you are not an admin/volunteer.",
              });
            }
          } else {
            // If pet is found, check if current user is pet owner, admin, or volunteer
            if (
              pet.createdByUserId !== req.decoded.uid &&
              req.decoded.role !== "admin" &&
              req.decoded.role !== "volunteer" // Added volunteer role check
            ) {
              return res.status(403).send({
                message:
                  "Forbidden: You do not have permission to update this request.",
              });
            }
          }

          const updateResult = await adoptionRequestsCollection.updateOne(
            { _id: request._id }, // Use the found _id (ObjectId or string)
            { $set: { status: status } }
          );

          if (updateResult.matchedCount === 0) {
            return res.status(404).send({
              message: "Request not found or status already updated.",
            });
          }

          if (status === "accepted") {
            if (pet) {
              const petUpdateResult = await petsCollection.updateOne(
                { _id: pet._id }, // Use the found _id (ObjectId or string)
                { $set: { adopted: true } }
              );
              if (petUpdateResult.matchedCount === 0) {
                console.warn(
                  `Pet ${pet._id} not found when trying to mark as adopted after request acceptance.`
                );
              }
            } else {
              console.warn(
                `Pet not found for adoption request ${requestId}, cannot mark as adopted.`
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

   app.get('/adopted-pets', verifyFBToken, attachUserRole, async (req, res) => {
  try {
    const userRole = req.decoded.role;
    const authUserId = req.decoded.uid;

    const filter = { adopted: true };

    // If not admin, only return their adopted pets (they created and marked adopted)
    if (userRole !== 'admin') {
      filter.createdByUserId = authUserId;
    }

    const adoptedPets = await petsCollection.find(filter).toArray();
    res.send(adoptedPets);
  } catch (error) {
    console.error("Error fetching adopted pets:", error);
    res.status(500).send({ message: "Failed to retrieve adopted pets." });
  }
});


    app.get(
      "/volunteer-tasks/:volunteerId", // volunteerId is Firebase UID (string)
      verifyFBToken,
      attachUserRole,
      verifyVolunteer,
      async (req, res) => {
        const volunteerId = req.params.volunteerId; // Firebase UID (string)

        try {
          // Verify the user is a volunteer (query by UID)
          const volunteer = await usersCollection.findOne({
            uid: volunteerId, // Query by Firebase UID (string)
            role: "volunteer",
          });

          if (!volunteer) {
            return res.status(404).send({ message: "Volunteer not found" });
          }

          const tasks = await tasksCollection
            .aggregate([
              {
                $match: { assignedTo: volunteerId }, // Match by Firebase UID (string)
              },
              {
                $lookup: {
                  from: "users",
                  localField: "assignedBy", // This is Firebase UID (string)
                  foreignField: "uid", // Link to 'uid' field in users collection
                  as: "assignedByUser",
                },
              },
              {
                $unwind: {
                  path: "$assignedByUser",
                  preserveNullAndEmptyArrays: true,
                }, // Preserve tasks even if user not found
              },
              {
                $sort: { createdAt: -1 },
              },
            ])
            .toArray();

          res.send(tasks);
        } catch (error) {
          console.error("Error fetching volunteer tasks:", error);
          res.status(500).send({ message: "Failed to fetch volunteer tasks" });
        }
      }
    );
    app.get("/admin/adopted-pets", verifyFBToken, attachUserRole, verifyAdmin, async (req, res) => {
  try {
    const approvedAdoptions = await adoptionRequestsCollection.find({ status: "approved" }).toArray();
    res.send(approvedAdoptions);
  } catch (error) {
    console.error("Error fetching all approved adoptions:", error);
    res.status(500).send({ message: "Failed to fetch approved adoptions." });
  }
});
    
// This route is located within your `run()` function in index.js

// NEW ROUTE: Get adoption requests for a specific user (User View)
// This route will be used by the frontend to fetch a user's requests (pending, approved, rejected)
app.get(
  "/user/adoption-requests", // The endpoint URL
  verifyFBToken,             // Middleware to verify Firebase ID token and attach decoded token to req.decoded
  attachUserRole,            // Middleware to fetch user's role from DB and attach to req.decoded
  async (req, res) => {
    // Get the requester's user ID directly from the authenticated Firebase token
    // This is the secure way to identify the user making the request.
    const requesterIdFromToken = req.decoded.uid;

    try {
      // Fetch adoption requests from the 'adoptionRequestsCollection'
      // It filters requests where the 'requesterId' field matches the authenticated user's UID.
      const userRequests = await adoptionRequestsCollection.find({ requesterId: requesterIdFromToken }).toArray();

      // Send the fetched requests as a 200 OK response
      res.status(200).send(userRequests);
    } catch (error) {
      // Log any errors that occur during the database operation
      console.error("Error fetching user's adoption requests:", error);
      // Send a 500 Internal Server Error response if something goes wrong
      res.status(500).send({ message: "Failed to fetch user's adoption requests." });
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
