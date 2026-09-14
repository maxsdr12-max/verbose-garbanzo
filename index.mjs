
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const MAX_DOCUMENT_BYTES = 250 * 1024 * 1024;
const upload = multer({
    dest: "/tmp/learnflow-documents",
    limits: { fileSize: MAX_DOCUMENT_BYTES }
});

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv", ".json", ".log", ".rtf"]);

const PORT = Number(process.env.PORT || 8787);
const MODEL = "ministral-14b-2512";

// =========================
// HEALTH CHECK
// =========================

app.get("/health", (_req, res) => {
    res.json({
        ok: true,
        provider: "mistral",
        model: MODEL
    });
});
app.get("/models", async (_req, res) => {
    try {
        const response = await fetch(
            "https://api.mistral.ai/v1/models",
            {
                headers: {
                    "Authorization":
                        "Bearer " + process.env.MISTRAL_API_KEY
                }
            }
        );

        const text = await response.text();

        if (!response.ok) {
            return res.status(response.status).send(text);
        }

        const data = JSON.parse(text);

        const models = (data.data || []).map(model => ({
            id: model.id,
            capabilities: model.capabilities,
            max_context_length: model.max_context_length,
            archived: model.archived
        }));

        res.json({
            count: models.length,
            models
        });
    } catch (error) {
        res.status(500).json({
            error: error?.message || String(error)
        });
    }
});
// =========================
// MISTRAL AI
// =========================

async function mistral(messages, schema) {
    if (!process.env.MISTRAL_API_KEY) {
        throw new Error("MISTRAL_API_KEY fehlt.");
    }

    const body = {
        model: MODEL,
        messages: [
            ...messages,
            {
                role: "system",
                content:
                    "Antworte ausschließlich mit gültigem JSON. " +
                    "Halte dich exakt an dieses Schema:\n" +
                    JSON.stringify(schema.schema)
            }
        ],
        temperature: 0.55,
        max_tokens: 5000
    };

    try {
        const response = await fetch(
            "https://api.mistral.ai/v1/chat/completions",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization":
                        "Bearer " + process.env.MISTRAL_API_KEY
                },
                body: JSON.stringify(body)
            }
        );

        const text = await response.text();

        if (!response.ok) {
            throw new Error(
                `${MODEL} ${response.status}: ${text}`
            );
        }

        const data = JSON.parse(text);

        const content =
            data?.choices?.[0]?.message?.content;

        if (!content) {
            throw new Error(
                `${MODEL}: keine Antwort erhalten`
            );
        }

        // Falls Mistral trotzdem Markdown-Codeblöcke zurückgibt
        let cleanContent = content.trim();

        if (cleanContent.startsWith("```json")) {
            cleanContent = cleanContent
                .replace(/^```json\s*/, "")
                .replace(/\s*```$/, "");
        } else if (cleanContent.startsWith("```")) {
            cleanContent = cleanContent
                .replace(/^```\s*/, "")
                .replace(/\s*```$/, "");
        }

        try {
            return JSON.parse(cleanContent);
        } catch {
            throw new Error(
                `${MODEL}: ungültiges JSON erhalten: ${cleanContent.slice(0, 500)}`
            );
        }
    } catch (error) {
        throw new Error(
            `Mistral fehlgeschlagen: ${
                error?.message || String(error)
            }`
        );
    }
}

// =========================
// DOKUMENTE
// =========================

function documentExtension(filename = "") {
    return path.extname(filename).toLowerCase();
}

async function extractUploadedDocument(file) {
    const ext = documentExtension(file.originalname);
    const buffer = await fs.readFile(file.path);

    if (TEXT_EXTENSIONS.has(ext)) {
        return buffer.toString("utf8");
    }

    if (ext === ".docx") {
        const result = await mammoth.extractRawText({ buffer });
        return result.value || "";
    }

    if (ext === ".pdf") {
        const parser = new PDFParse({ data: buffer });
        try {
            const result = await parser.getText();
            return result.text || "";
        } finally {
            await parser.destroy();
        }
    }

    throw new Error(
        "Dateityp nicht unterstützt. Erlaubt: TXT, MD, CSV, JSON, LOG, RTF, DOCX und PDF."
    );
}

app.post("/api/documents/extract", upload.single("file"), async (req, res) => {
    let tempPath = req.file?.path;

    try {
        if (!req.file) {
            return res.status(400).json({
                error: "Keine Datei hochgeladen."
            });
        }

        const text = (await extractUploadedDocument(req.file)).trim();

        if (!text) {
            return res.status(422).json({
                error: "Aus dem Dokument konnte kein Text gelesen werden."
            });
        }

        res.json({
            ok: true,
            name: req.file.originalname,
            size: req.file.size,
            type: req.file.mimetype,
            text
        });
    } catch (error) {
        console.error("Dokument-Fehler:", error);

        const message =
            error?.code === "LIMIT_FILE_SIZE"
                ? "Die Datei ist zu groß. Maximal 250 MB sind erlaubt."
                : error?.message || "Dokument konnte nicht verarbeitet werden.";

        res.status(error?.code === "LIMIT_FILE_SIZE" ? 413 : 500).json({
            error: message
        });
    } finally {
        if (tempPath) {
            await fs.unlink(tempPath).catch(() => {});
        }
    }
});

// =========================
// LEARNPLAN

// =========================

app.post("/api/plan", async (req, res) => {
    try {
        const {
            goal,
            minutes,
            weeks,
            categories = [],
            notes = [],
            documents = []
        } = req.body;

        const cats =
            categories
                .map(
                    c =>
                        `${c.name}: ${(c.noteTitles || []).join(", ")}`
                )
                .join("\n") || "Keine Kategorien.";

        const ns =
            notes
                .map(
                    n =>
                        `- ${n.title}: ${String(
                            n.content || ""
                        ).slice(0, 1200)}`
                )
                .join("\n") || "Keine Notizen.";

        const docs =
            documents
                .map(
                    d =>
                        `- ${d.name}: ${String(
                            d.content || ""
                        ).slice(0, 20000)}`
                )
                .join("\n\n") || "Keine Dokumente.";
        const out = await mistral(
            [
                {
                    role: "system",
                    content:
                        "Du bist LearnFlow, ein Lernplan-Assistent. " +
                        "Erstelle realistische Lernpläne aus Kategorien und Notizen. " +
                        "Nutze verschiedene Methoden wie verstehen, wiederholen, " +
                        "anwenden, erklären und testen. " +
                        "Antworte ausschließlich mit JSON."
                },
                {
                    role: "user",
                    content:
                        `Ziel: ${goal}\n` +
                        `Minuten pro Tag: ${minutes}\n` +
                        `Wochen: ${weeks}\n` +
                        `Kategorien:\n${cats}\n` +
                        `Notizen:\n${ns}\n` +
                        `Dokumente:\n${docs}`
                }
            ],
            {
                name: "learnflow_plan",
                strict: true,
                schema: {
                    type: "object",
                    properties: {
                        title: {
                            type: "string"
                        },
                        summary: {
                            type: "string"
                        },
                        weeks: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    week: {
                                        type: "integer"
                                    },
                                    focus: {
                                        type: "string"
                                    },
                                    tasks: {
                                        type: "array",
                                        items: {
                                            type: "object",
                                            properties: {
                                                title: {
                                                    type: "string"
                                                },
                                                category: {
                                                    type: "string"
                                                },
                                                minutes: {
                                                    type: "integer"
                                                },
                                                type: {
                                                    type: "string"
                                                }
                                            },
                                            required: [
                                                "title",
                                                "category",
                                                "minutes",
                                                "type"
                                            ],
                                            additionalProperties: false
                                        }
                                    }
                                },
                                required: [
                                    "week",
                                    "focus",
                                    "tasks"
                                ],
                                additionalProperties: false
                            }
                        }
                    },
                    required: [
                        "title",
                        "summary",
                        "weeks"
                    ],
                    additionalProperties: false
                }
            }
        );

        res.json(out);
    } catch (error) {
        console.error("Plan-Fehler:", error);

        res.status(500).json({
            error:
                error?.message ||
                "AI-Fehler"
        });
    }
});

// =========================
// FRAGEN / FEED
// =========================

app.post("/api/questions", async (req, res) => {
    try {
        const {
            planTitle = "",
            goal = "",
            categories = [],
            notes = [],
            documents = [],
            count = 7
        } = req.body;

        const cats =
            categories
                .map(
                    c =>
                        `${c.name}: ${(c.noteTitles || []).join(", ")}`
                )
                .join("\n") || "Keine Kategorien.";

        const ns =
            notes
                .map(
                    n =>
                        `${n.title}: ${String(
                            n.content || ""
                        ).slice(0, 1400)}`
                )
                .join("\n") || "Keine Notizen.";

        const docs =
            documents
                .map(
                    d =>
                        `${d.name}: ${String(
                            d.content || ""
                        ).slice(0, 20000)}`
                )
                .join("\n\n") || "Keine Dokumente.";
        const questionCount = Math.min(
            10,
            Math.max(3, Number(count) || 7)
        );

        const out = await mistral(
            [
                {
                    role: "system",
                    content:
                        "Du bist ein intelligenter Lerncoach. " +
                        "Erstelle Multiple-Choice-Fragen aus den gelieferten Lerninhalten. " +
                        "Mische Themen bei mehreren Kategorien. " +
                        "Keine Trickfragen. Genau eine Antwort ist richtig. " +
                        "Antworte ausschließlich mit JSON."
                },
                {
                    role: "user",
                    content:
                        `Plan: ${planTitle}\n` +
                        `Ziel: ${goal}\n` +
                        `Anzahl: ${questionCount}\n` +
                        `Kategorien:\n${cats}\n` +
                        `Notizen:\n${ns}\n` +
                        `Dokumente:\n${docs}`
                }
            ],
            {
                name: "learnflow_questions",
                strict: true,
                schema: {
                    type: "object",
                    properties: {
                        questions: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    question: {
                                        type: "string"
                                    },
                                    options: {
                                        type: "array",
                                        items: {
                                            type: "string"
                                        },
                                        minItems: 4,
                                        maxItems: 4
                                    },
                                    answer: {
                                        type: "integer",
                                        minimum: 0,
                                        maximum: 3
                                    },
                                    explanation: {
                                        type: "string"
                                    },
                                    category: {
                                        type: "string"
                                    },
                                    difficulty: {
                                        type: "string"
                                    }
                                },
                                required: [
                                    "question",
                                    "options",
                                    "answer",
                                    "explanation",
                                    "category",
                                    "difficulty"
                                ],
                                additionalProperties: false
                            }
                        }
                    },
                    required: [
                        "questions"
                    ],
                    additionalProperties: false
                }
            }
        );

        res.json(out);
    } catch (error) {
        console.error("Questions-Fehler:", error);

        res.status(500).json({
            error:
                error?.message ||
                "AI-Fehler"
        });
    }
});

// =========================
// SERVER START
// =========================

app.listen(PORT, "0.0.0.0", () => {
    console.log(`LearnFlow AI-Backend läuft auf Port ${PORT}`);
});
