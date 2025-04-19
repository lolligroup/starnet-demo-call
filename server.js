const express = require("express");
const fs = require("fs");
const https = require("https");
const path = require("path");
const { OpenAI } = require("openai");
const { twiml: { VoiceResponse } } = require("twilio");
const twilio = require("twilio");

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.urlencoded({ extended: false }));
app.use(express.static("public"));

// 1. Stella parla e registra
app.post("/voce", (req, res) => {
  const response = new VoiceResponse();
  response.say({ voice: "alice", language: "it-IT" }, "Ciao! Sono Stella di StarNet. Come stai oggi?");
  response.record({
    maxLength: 6,
    action: "/risposta",
    method: "POST",
    playBeep: true
  });
  response.say("Non ho ricevuto risposta. Alla prossima!");
  response.hangup();
  res.type("text/xml");
  res.send(response.toString());
});

// 2. Riceve l'audio e risponde con OpenAI
app.post("/risposta", async (req, res) => {
  const recordingUrl = req.body.RecordingUrl + ".mp3";
  const audioPath = path.join(__dirname, "public", "registrazione.mp3");
  const rispostaPath = path.join(__dirname, "public", "risposta.mp3");

  console.log("📥 Ricevuto audio:", recordingUrl);

  const file = fs.createWriteStream(audioPath);
  https.get(recordingUrl, (response) => {
    response.pipe(file);
    file.on("finish", async () => {
      file.close();

      try {
        // Whisper
        const transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream(audioPath),
          model: "whisper-1"
        });
        const testo = transcription.text;
        console.log("📝 Trascritto:", testo);

        // GPT
        const chat = await openai.chat.completions.create({
          model: "gpt-4",
          messages: [
            { role: "system", content: "Rispondi come Stella, l'assistente vocale gentile di StarNet." },
            { role: "user", content: testo }
          ]
        });
        const rispostaGPT = chat.choices[0].message.content;
        console.log("🤖 GPT risponde:", rispostaGPT);

        // TTS
        const audio = await openai.audio.speech.create({
          model: "tts-1",
          voice: "nova",
          input: rispostaGPT
        });
        const buffer = Buffer.from(await audio.arrayBuffer());
        fs.writeFileSync(rispostaPath, buffer);
        console.log("🔊 Audio generato:", rispostaPath);

        // Riproduce la risposta
        const response = new VoiceResponse();
        response.play("https://" + req.headers.host + "/risposta.mp3");
        response.hangup();

        res.type("text/xml").send(response.toString());
      } catch (err) {
        console.error("❌ Errore AI:", err.message);
        res.status(500).send("Errore AI");
      }
    });
  }).on("error", (err) => {
    console.error("❌ Errore download:", err.message);
    res.status(500).send("Errore audio");
  });
});

// 3. Avvia la chiamata da browser
app.get("/chiama", async (req, res) => {
  const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);

  try {
    const call = await client.calls.create({
      url: "https://" + req.headers.host + "/voce",
      to: process.env.TWILIO_TO,
      from: process.env.TWILIO_FROM
    });

    console.log("📞 Chiamata avviata:", call.sid);
    res.send("📞 Chiamata in partenza verso " + process.env.TWILIO_TO);
  } catch (err) {
    console.error("❌ Errore Twilio:", err.message);
    res.status(500).send("Errore chiamata: " + err.message);
  }
});

// Avvio server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🟢 Server attivo sulla porta", PORT);
});
