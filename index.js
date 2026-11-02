import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import cors from "cors";
import cookieParser from "cookie-parser";
import "dotenv/config";
import { createRemoteJWKSet, jwtVerify } from "jose";
const app = express();
const PORT = process.env.PORT || 8000;
const TOKEN_COOKIE = "studiospace_token";
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

const CATEGORIES = [
  "Photo Studio",
  "Film Stage",
  "Podcast Lounge",
  "Music Suite",
  "Workshop",
];
const BOOKING_STATUSES = ["Pending", "Confirmed", "Completed", "Cancelled"];

const client = new MongoClient(process.env.MONGODB_URI);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

app.use(
  cors({
    origin: process.env.CLIENT_URL,
    credentials: true,
  }),
);
app.use(express.json());
app.use(cookieParser());

const mongoClient = await connectToMongoDB();
const db = mongoClient.db("studiospace");
const studioCollection = db.collection("studios");
const bookingCollection = db.collection("bookings");
const reviewCollection = db.collection("reviews");
const wishlistCollection = db.collection("wishlist");

const JWKS = createRemoteJWKSet(
  new URL(`${process.env.CLIENT_URL}/api/auth/jwks`),
);

const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
};

const verifyToken = async (req, res, next) => {
  const token = req.cookies[TOKEN_COOKIE];
  if (!token) {
    return res.status(401).send({ msg: "Unauthorized!" });
  }

  try {
    const { payload } = await jwtVerify(token, JWKS);
    req.user = {
      id: payload.id || payload.sub,
      name: payload.name,
      email: payload.email,
      image: payload.image,
    };
    next();
  } catch (error) {
    return res.status(401).send({ msg: "Unauthorized!" });
  }
};

const toObjectId = (id) => (ObjectId.isValid(id) ? new ObjectId(id) : null);

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const toMinutes = (time) => {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
};

const isValidTime = (value) =>
  typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

const isValidDate = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(new Date(value).getTime());

const roundMoney = (value) => Math.round(value * 100) / 100;

const buildStudioPayload = (body) => {
  const title = String(body.title || "").trim();
  const category = String(body.category || "").trim();
  const location = String(body.location || "").trim();
  const imageUrl = String(body.imageUrl || "").trim();
  const overview = String(body.overview || "").trim();
  const hourlyRate = Number(body.hourlyRate);
  const securityDeposit = Number(body.securityDeposit);
  const maxCapacity = Number(body.maxCapacity);

  if (!title || !location || !imageUrl || !overview) {
    return { error: "Title, location, image and overview are required." };
  }
  if (!CATEGORIES.includes(category)) {
    return { error: "Please choose a valid studio category." };
  }
  if (!(hourlyRate > 0)) {
    return { error: "Hourly rate must be greater than zero." };
  }
  if (!(securityDeposit >= 0)) {
    return { error: "Security deposit cannot be negative." };
  }
  if (!(maxCapacity >= 1)) {
    return { error: "Maximum capacity must be at least 1." };
  }

  const cleanList = (list) =>
    Array.isArray(list)
      ? list.map((item) => String(item).trim()).filter(Boolean)
      : [];

  const amenities = [...new Set(cleanList(body.amenities))];
  const gallery = [...new Set([imageUrl, ...cleanList(body.gallery)])];

  return {
    data: {
      title,
      category,
      hourlyRate,
      securityDeposit,
      maxCapacity: Math.floor(maxCapacity),
      location,
      imageUrl,
      gallery,
      amenities,
      overview,
    },
  };
};

const refreshStudioRating = async (studioId) => {
  const [stats] = await reviewCollection
    .aggregate([
      { $match: { studioId } },
      {
        $group: {
          _id: "$studioId",
          average: { $avg: "$rating" },
          count: { $sum: 1 },
        },
      },
    ])
    .toArray();

  await studioCollection.updateOne(
    { _id: new ObjectId(studioId) },
    {
      $set: {
        rating: stats ? Math.round(stats.average * 10) / 10 : 0,
        reviewCount: stats ? stats.count : 0,
      },
    },
  );
};

const findConfirmedConflict = (booking, ignoreId) => {
  const query = {
    studioId: booking.studioId,
    date: booking.date,
    status: "Confirmed",
    startMinutes: { $lt: booking.endMinutes },
    endMinutes: { $gt: booking.startMinutes },
  };
  if (ignoreId) {
    query._id = { $ne: ignoreId };
  }
  return bookingCollection.findOne(query);
};

const conflictMessage = (conflict) =>
  `This studio is already booked from ${conflict.startTime} to ${conflict.endTime} on ${conflict.date}. Please choose a different time slot.`;

