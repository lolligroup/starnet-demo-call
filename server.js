const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { OpenAI } = require("openai");
const cors = require("cors");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const app = express();
const upload = multer({ dest: "uploads/" });

app.use(cors());
app.use(express.static("public"));

app.post("/chat", upload.single("audio"), async (req, res) => {
  const audioPath = req.file.path;
  try {
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: "whisper-1"
    });

    const userText = transcription.text;

    const chat = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: "Rispondi come un'assistente vocale gentile e simpatica di nome Stella." },
        { role: "user", content: userText }
      ]
    });

    const aiReply = chat.choices[0].message.content;

    const speech = await openai.audio.speech.create({
      model: "tts-1",
      voice: "nova",
      input: aiReply
    });

    const outputPath = path.join("public", "response.mp3");
    const buffer = Buffer.from(await speech.arrayBuffer());
    fs.writeFileSync(outputPath, buffer);

    res.json({ transcription: userText, reply: aiReply, audio: "/response.mp3" });
  } catch (error) {
    console.error("Errore:", error);
    res.status(500).json({ error: "Errore nella generazione della risposta" });
  } finally {
    fs.unlinkSync(audioPath);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🟢 Server attivo sulla porta", PORT);
});
