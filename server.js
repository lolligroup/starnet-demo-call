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
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const chatSessions = {}; // memoria RAM per CallSid

// 1. INIZIO chiamata: saluto e ascolto
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

// 2. INTERAZIONE AI (loop)
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

      // Converti da mp3 a wav (per Whisper)
      ffmpeg(mp3Path)
        .toFormat("wav")
        .on("end", async () => {
          try {
            // 1. Trascrizione
            const transcription = await openai.audio.transcriptions.create({
              file: fs.createReadStream(wavPath),
              model: "whisper-1"
            });

            const testo = transcription.text.trim();
            console.log(`[${callSid}] 🗣️ Utente:`, testo);

            // 2. Inizializza sessione se serve
            if (!chatSessions[callSid]) {
              chatSessions[callSid] = [
                { role: "system", content: "Rispondi come Stella, assistente vocale gentile e premurosa di StarNet." }
              ];
            }
            chatSessions[callSid].push({ role: "user", content: testo });

            // 3. GPT
            const chat = await openai.chat.completions.create({
              model: "gpt-4",
              messages: chatSessions[callSid]
            });

            const rispostaGPT = chat.choices[0].message.content;
            chatSessions[callSid].push({ role: "assistant", content: rispostaGPT });

            console.log(`[${callSid}] 🤖 Stella:`, rispostaGPT);

            // 4. TTS
            const audio = await openai.audio.speech.create({
              model: "tts-1",
              voice: "nova",
              input: rispostaGPT
            });

            const buffer = Buffer.from(await audio.arrayBuffer());
            fs.writeFileSync(rispostaPath, buffer);

            // 5. Twilio: riproduce e registra di nuovo
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
            console.error("❌ Errore AI:", err.message);
            const twiml = new VoiceResponse();
            twiml.say({ voice: "alice", language: "it-IT" }, "C'è stato un errore. A presto!");
            twiml.hangup();
            res.type("text/xml").send(twiml.toString());
          }
        })
        .on("error", (err) => {
          console.error("❌ Errore ffmpeg:", err.message);
          const twiml = new VoiceResponse();
          twiml.say({ voice: "alice", language: "it-IT" }, "C'è stato un errore audio.");
          twiml.hangup();
          res.type("text/xml").send(twiml.toString());
        })
        .save(wavPath);
    });
  });
});

// 3. CHIAMA l’utente da browser
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

// Avvio server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🟢 Server attivo sulla porta", PORT);
});
