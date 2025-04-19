const express = require("express");
const fs = require("fs");
const https = require("https");
const path = require("path");
const { OpenAI } = require("openai");
const { twiml: { VoiceResponse } } = require("twilio");
const twilio = require("twilio");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();

const uploadsDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
  console.log("📂 Cartella 'uploads/' creata");
} else {
  console.log("📁 Cartella 'uploads/' già esistente");
}


const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const chatSessions = {}; // memoria per conversazione

// ✅ 1. Inizia chiamata → solo Stella parla
app.post("/voce", (req, res) => {
  const response = new VoiceResponse();
  response.say({ voice: "alice", language: "it-IT" }, "Ciao! Sono Stella. Come stai oggi?");
  response.redirect("/ascolta");
  res.type("text/xml").send(response.toString());
});

// ✅ 2. Nuovo endpoint → SOLO registrazione
app.post("/ascolta", (req, res) => {
  const response = new VoiceResponse();
  response.record({
    maxLength: 15,
    timeout: 5,
    action: "/interazione",
    method: "POST",
    playBeep: true,
    trim: "trim-silence",
    finishOnKey: "#"
  });
  res.type("text/xml").send(response.toString());
});

// ✅ 3. Interazione vocale → Whisper + GPT + TTS
app.post("/interazione", async (req, res) => {
  const callSid = req.body.CallSid;
  const recordingUrl = req.body.RecordingUrl + ".mp3";
  const mp3Path = path.join(__dirname, "public", `${callSid}.mp3`);
  const wavPath = path.join(__dirname, "public", `${callSid}.wav`);
  const rispostaPath = path.join(__dirname, "public", `${callSid}_risposta.mp3`);

  const file = fs.createWriteStream(mp3Path);
  https.get(recordingUrl, (response) => {
    response.pipe(file);
    file.on("finish", () => {
      file.close();

      setTimeout(() => {
        const size = fs.existsSync(mp3Path) ? fs.statSync(mp3Path).size : 0;
        if (size < 1000) {
          const twiml = new VoiceResponse();
          twiml.say({ voice: "alice", language: "it-IT" }, "Non ho sentito nulla. Riproviamo.");
          twiml.redirect("/ascolta");
          return res.type("text/xml").send(twiml.toString());
        }

        ffmpeg(mp3Path)
          .toFormat("wav")
          .on("end", async () => {
            try {
              const transcription = await openai.audio.transcriptions.create({
                file: fs.createReadStream(wavPath),
                model: "whisper-1"
              });

              const testo = transcription.text.trim();
              console.log(`[${callSid}] 🗣️ Utente:`, testo);

              if (!chatSessions[callSid]) {
                chatSessions[callSid] = [
                  { role: "system", content: "Rispondi come Stella, l'assistente vocale gentile e premurosa di StarNet." }
                ];
              }

              chatSessions[callSid].push({ role: "user", content: testo });

              const chat = await openai.chat.completions.create({
                model: "gpt-4",
                messages: chatSessions[callSid]
              });

              const rispostaGPT = chat.choices[0].message.content;
              chatSessions[callSid].push({ role: "assistant", content: rispostaGPT });

              const audio = await openai.audio.speech.create({
                model: "tts-1",
                voice: "nova",
                input: rispostaGPT
              });

              const buffer = Buffer.from(await audio.arrayBuffer());
              fs.writeFileSync(rispostaPath, buffer);

              const twiml = new VoiceResponse();
              twiml.play(`https://${req.headers.host}/${callSid}_risposta.mp3`);
              twiml.redirect("/ascolta");

              res.type("text/xml").send(twiml.toString());
            } catch (err) {
              console.error("❌ Errore AI:", err.message);
              const twiml = new VoiceResponse();
              twiml.say({ voice: "alice", language: "it-IT" }, "Errore durante la risposta. Alla prossima!");
              twiml.hangup();
              res.type("text/xml").send(twiml.toString());
            }
          })
          .on("error", (err) => {
            console.error("❌ Errore ffmpeg:", err.message);
            const twiml = new VoiceResponse();
            twiml.say({ voice: "alice", language: "it-IT" }, "Errore nella conversione audio.");
            twiml.hangup();
            res.type("text/xml").send(twiml.toString());
          })
          .save(wavPath);
      }, 300);
    });
  });
});

// ✅ 4. Endpoint per avviare la chiamata
app.get("/chiama", async (req, res) => {
  const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);

  try {
    const call = await client.calls.create({
      url: "https://" + req.headers.host + "/voce",
      to: process.env.TWILIO_TO,
      from: process.env.TWILIO_FROM
    });

    console.log("📞 Chiamata avviata:", call.sid);
    res.send("✅ Chiamata avviata verso " + process.env.TWILIO_TO);
  } catch (err) {
    console.error("❌ Errore chiamata:", err.message);
    res.status(500).send("Errore chiamata: " + err.message);
  }
});

const multer = require("multer");
const upload = multer({ dest: "uploads/" });

app.post("/chat", upload.single("audio"), async (req, res) => {
  const audioPath = req.file.path;

  try {
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: "whisper-1"
    });

    const testoUtente = transcription.text;

    const chat = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: "Rispondi come Stella, assistente vocale gentile e simpatica." },
        { role: "user", content: testoUtente }
      ]
    });

    const rispostaGPT = chat.choices[0].message.content;

    const speech = await openai.audio.speech.create({
      model: "tts-1",
      voice: "nova",
      input: rispostaGPT
    });

    const outputPath = path.join("public", "response.mp3");
    const buffer = Buffer.from(await speech.arrayBuffer());
    fs.writeFileSync(outputPath, buffer);

    res.json({
      transcription: testoUtente,
      reply: rispostaGPT,
      audio: "/response.mp3"
    });
  } catch (err) {
    console.error("❌ Errore /chat:", err.message);
    res.status(500).json({ error: "Errore durante la risposta vocale" });
  } finally {
    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
  }
});


// ✅ Avvio server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🟢 Server attivo sulla porta", PORT);
});
