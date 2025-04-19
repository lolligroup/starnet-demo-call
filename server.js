const express = require("express");
const fs = require("fs");
const https = require("https");
const path = require("path");
const { OpenAI } = require("openai");
const { twiml: { VoiceResponse } } = require("twilio");
require("dotenv").config();

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const chatSessions = {}; // 🧠 memoria in RAM per ogni CallSid

// 1. INIZIO chiamata → saluta e ascolta
app.post("/voce", (req, res) => {
  const response = new VoiceResponse();
  response.say({ voice: "alice", language: "it-IT" }, "Ciao! Sono Stella. Come stai oggi?");
  response.record({
    maxLength: 8,
    action: "/interazione",
    method: "POST",
    playBeep: true,
    trim: "trim-silence"
  });
  res.type("text/xml").send(response.toString());
});

// 2. OGNI risposta dell’utente → AI elabora e riascolta
app.post("/interazione", async (req, res) => {
  const callSid = req.body.CallSid;
  const recordingUrl = req.body.RecordingUrl + ".mp3";
  const audioPath = path.join(__dirname, "public", `${callSid}.mp3`);
  const rispostaPath = path.join(__dirname, "public", `${callSid}_risposta.mp3`);

  const file = fs.createWriteStream(audioPath);
  https.get(recordingUrl, (response) => {
    response.pipe(file);
    file.on("finish", async () => {
      file.close();
      try {
        // Trascrivi
        const transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream(audioPath),
          model: "whisper-1"
        });

        const testo = transcription.text.trim();
        console.log(`[${callSid}] 🗣️ Utente:`, testo);

        // Crea o aggiorna la sessione
        if (!chatSessions[callSid]) {
          chatSessions[callSid] = [
            { role: "system", content: "Rispondi come Stella, assistente vocale gentile e simpatica." }
          ];
        }

        chatSessions[callSid].push({ role: "user", content: testo });

        // GPT
        const chat = await openai.chat.completions.create({
          model: "gpt-4",
          messages: chatSessions[callSid]
        });

        const rispostaGPT = chat.choices[0].message.content;
        chatSessions[callSid].push({ role: "assistant", content: rispostaGPT });

        console.log(`[${callSid}] 🤖 Stella:`, rispostaGPT);

        // TTS
        const audio = await openai.audio.speech.create({
          model: "tts-1",
          voice: "nova",
          input: rispostaGPT
        });

        const buffer = Buffer.from(await audio.arrayBuffer());
        fs.writeFileSync(rispostaPath, buffer);

        // Risposta Twilio + nuovo record (loop)
        const twiml = new VoiceResponse();
        twiml.play(`https://${req.headers.host}/${callSid}_risposta.mp3`);
        twiml.record({
          maxLength: 8,
          action: "/interazione",
          method: "POST",
          playBeep: true,
          trim: "trim-silence"
        });

        res.type("text/xml").send(twiml.toString());
      } catch (err) {
        console.error("❌ Errore:", err.message);
        const twiml = new VoiceResponse();
        twiml.say({ voice: "alice", language: "it-IT" }, "C'è stato un errore. A presto!");
        twiml.hangup();
        res.type("text/xml").send(twiml.toString());
      }
    });
  });
});

// Avvio server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🟢 Server attivo sulla porta", PORT);
});
