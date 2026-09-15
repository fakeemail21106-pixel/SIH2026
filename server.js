require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 5000;
const HF_API_KEY = process.env.HF_API_KEY;
const HF_MODEL = process.env.HF_MODEL || "meta-llama/Llama-3.1-8B-Instruct";

app.use(cors());
app.use(express.json());

// ==========================================
// SUPABASE CLIENT (optional — server still runs without it)
// ==========================================
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  console.log("🗄️  Supabase client initialized.");
} else {
  console.warn("⚠️  Supabase env vars missing — live location & SOS logging to DB disabled.");
}

// ==========================================
// HUGGING FACE ROUTER INTEGRATION
// ==========================================
const callHuggingFace = async (prompt, retries = 2) => {
  if (!HF_API_KEY || !HF_API_KEY.startsWith("hf_")) {
    console.error("❌ ERROR: Invalid or missing HF_API_KEY in .env file.");
    return "API configuration error. Please check your .env file.";
  }

  // Official Hugging Face Router Endpoint (OpenAI Compatible)
  // NOTE: intentionally NOT the "/hf-inference/" path — that pins requests to
  // one specific backend, and many models (including Llama 3.1) aren't served
  // by it. The plain "/v1/chat/completions" router auto-picks whichever
  // backend (Cerebras, Groq, Fireworks, Together, etc.) actually hosts the model.
  const endpoint = "https://router.huggingface.co/v1/chat/completions";

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      console.log(`📡 Querying HF Router Engine (Attempt ${attempt + 1}/${retries + 1})...`);

      const response = await axios.post(
        endpoint,
        {
          model: HF_MODEL,
          messages: [
            {
              role: "system",
              content: "You are an AI Travel & Emergency Assistant for SIH Tourism. Provide direct, helpful, and concise responses."
            },
            { role: "user", content: prompt }
          ],
          max_tokens: 300,
          temperature: 0.3
        },
        {
          headers: {
            Authorization: `Bearer ${HF_API_KEY}`,
            "Content-Type": "application/json"
          },
          timeout: 25000
        }
      );

      const reply = response.data?.choices?.[0]?.message?.content;
      if (reply) {
        return reply.trim();
      }

      return "Received empty response from AI engine.";

    } catch (err) {
      const status = err.response?.status;
      const errorDetails = err.response?.data || err.message;

      console.error(`⚠️ HF Request Failed [Status ${status || "Network/Timeout"}]:`, errorDetails);

      if (attempt < retries) {
        console.log("⏳ Retrying request in 2 seconds...");
        await new Promise((res) => setTimeout(res, 2000));
        continue;
      }

      if (status === 401) {
        return "Authentication failed: Invalid Hugging Face API key in backend .env.";
      }

      return "AI Assistant temporarily offline. Please check terminal logs.";
    }
  }
};

// ==========================================
// REST API ENDPOINTS
// ==========================================

// Health check — used by the frontend to confirm the backend is reachable
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    hfConfigured: !!(HF_API_KEY && HF_API_KEY.startsWith("hf_")),
    supabaseConfigured: !!supabase,
    time: new Date().toISOString()
  });
});

// AI Assistant Chat & Budget Endpoint
app.post("/api/ai/ask", async (req, res) => {
  try {
    const { prompt, location } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: "Prompt is required." });
    }

    // Budget Optimization Logic
    const budgetMatch = prompt.match(/(?:budget|optimize)\D*(\d+)/i);
    if (budgetMatch) {
      const total = parseInt(budgetMatch[1], 10);
      return res.json({
        data: {
          totalBudget: total,
          allocations: {
            accommodation: Math.round(total * 0.30),
            transportation: Math.round(total * 0.25),
            food: Math.round(total * 0.18),
            activities: Math.round(total * 0.10),
            emergencyReserve: Math.round(total * 0.10),
            miscellaneous: Math.round(total * 0.07)
          }
        }
      });
    }

    const contextualPrompt = location 
      ? `User Location: ${location}. Query: ${prompt}`
      : prompt;

    const aiAnswer = await callHuggingFace(contextualPrompt);
    return res.json({ data: { answer: aiAnswer } });

  } catch (error) {
    console.error("Server API Error:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// Emergency SOS Endpoint
app.post("/api/emergency/sos", async (req, res) => {
  const { userId, latitude, longitude } = req.body;

  const sosData = {
    status: "SOS_ACTIVATED",
    userId: userId || "ANONYMOUS_USER",
    location: { latitude, longitude },
    timestamp: new Date().toISOString(),
    nearestFacilities: {
      policeStation: "Central Police Station (1.2 km)",
      hospital: "City General Hospital (2.4 km)",
      shelter: "Municipal Relief Camp A (0.8 km)"
    }
  };

  // Persist to Supabase (non-blocking — SOS still fires even if DB write fails)
  if (supabase) {
    try {
      const { error } = await supabase.from("sos_events").insert({
        user_id: sosData.userId,
        latitude: latitude ?? null,
        longitude: longitude ?? null,
        status: sosData.status
      });
      if (error) console.error("⚠️ Supabase sos_events insert failed:", error.message);
    } catch (err) {
      console.error("⚠️ Supabase sos_events insert threw:", err.message);
    }
  }

  // Broadcast SOS across WebSockets in real time
  io.emit("sos_alert", sosData);

  return res.json(sosData);
});

// Disaster Heatmap Endpoint (falls back to static data if no DB / no rows yet)
app.get("/api/disaster/heatmap", async (req, res) => {
  const fallbackZones = [
    { zone: "Northern Valley", riskLevel: "HIGH", color: "🔴", roadStatus: "Closed" },
    { zone: "Central Town", riskLevel: "MODERATE", color: "🟡", roadStatus: "Open (Caution)" },
    { zone: "Southern Ridge", riskLevel: "LOW", color: "🟢", roadStatus: "Open" }
  ];

  if (supabase) {
    try {
      const { data, error } = await supabase.from("disaster_zones").select("*");
      if (!error && data && data.length > 0) {
        return res.json({ zones: data, source: "supabase" });
      }
    } catch (err) {
      console.error("⚠️ Supabase disaster_zones fetch failed:", err.message);
    }
  }

  return res.json({ zones: fallbackZones, source: "fallback" });
});

// Admin Analytics Endpoint
app.get("/api/admin/dashboard", async (req, res) => {
  let liveTouristCount = null;

  if (supabase) {
    try {
      const { count, error } = await supabase
        .from("live_locations")
        .select("*", { count: "exact", head: true });
      if (!error) liveTouristCount = count;
    } catch (err) {
      console.error("⚠️ Supabase live_locations count failed:", err.message);
    }
  }

  res.json({
    analytics: {
      totalTourists: liveTouristCount ?? 1420,
      activeAlerts: 1,
      crowdDensity: "Medium",
      hotelOccupancy: "78%"
    }
  });
});

// ==========================================
// WEBSOCKET LIFECYCLE
// ==========================================
io.on("connection", (socket) => {
  console.log(`⚡ WebSocket client connected: ${socket.id}`);

  socket.on("update_location", async (data) => {
    const { userId, latitude, longitude } = data || {};

    // Broadcast to every other connected client (admin map, caretakers, etc.)
    socket.broadcast.emit("location_feed", data);

    // Persist latest known position to Supabase
    if (supabase && userId && latitude != null && longitude != null) {
      try {
        const { error } = await supabase
          .from("live_locations")
          .upsert(
            { user_id: userId, latitude, longitude, updated_at: new Date().toISOString() },
            { onConflict: "user_id" }
          );
        if (error) console.error("⚠️ Supabase live_locations upsert failed:", error.message);
      } catch (err) {
        console.error("⚠️ Supabase live_locations upsert threw:", err.message);
      }
    }
  });

  socket.on("disconnect", () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
  });
});

// Start Server Listener
server.listen(PORT, () => {
  console.log(`🚀 SIH Tourism Engine running on http://localhost:${PORT}`);
});
