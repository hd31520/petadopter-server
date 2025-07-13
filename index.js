const express = require("express");
const cors = require("cors");
require("dotenv").config();
const app = express();
const port = 5000;
app.use(cors());
app.use(express.json());
app.get("/", (req, res) => {
  res.send("Hello World!");
});

const { MongoClient, ServerApiVersion } = require("mongodb");
const uri = process.env.URI;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();
    const db = client.db("adopty");
    const usersCollection = db.collection("users");
    const petsCollection = db.collection("pets");
    const donationCamCollection = db.collection("donation-cam");

    app.post("/users", async (req, res) => {
      const user = req.body;
      const email = user.email;

      if (!email) {
        return res.status(400).send({ message: "Email is required" });
      }

      const userExists = await usersCollection.findOne({ email });

      const currentTime = new Date().toISOString();

      if (userExists) {
        // ✅ Update last_log_in only
        await usersCollection.updateOne(
          { email },
          { $set: { last_log_in: user.last_log_in } }
        );

        return res.status(200).send({
          message: "User already exists. last_log_in updated.",
          inserted: false,
        });
      }

      // ✅ Build new user info object

      const result = await usersCollection.insertOne(user);
      res.status(201).send(result);
    });

    // petData

    app.get("/pets", async (req, res) => {
      const result = await petsCollection.find().toArray();
      console.log(result);
      res.send(result);
    });



     app.get("/donation-cam", async (req, res) => {
      const result = await donationCamCollection.find().toArray();
      console.log(result);
      res.send(result);
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

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
