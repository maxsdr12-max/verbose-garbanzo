```js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = Number(process.env.PORT || 8787);
const MODEL = "mistral-large-2512";

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
                    Authorization:
                        `Bearer ${process.env.MISTRAL_API_KEY}`
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

        try {
            return JSON.parse(content);
        } catch {
            throw new Error(
                `${MODEL}: ungültiges JSON erhalten`
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
// LEARNPLAN
// =========================

app.post("/api/plan", async (req, res) => {
    try {
        const {
            goal,
            minutes,
            weeks,
            categories = [],
            notes = []
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

        const out = await mistral(
            [
                {
                    role: "system",
                    content:
                        "Du bist LearnFlow, ein Lernplan-Assistent. " +
                        "Erstelle realistische Lernpläne aus Kategorien " +
                        "und Notizen. Nutze verschiedene Methoden wie " +
                        "verstehen, wiederholen, anwenden, erklären und testen. " +
                        "Nur JSON."
                },
                {
                    role: "user",
                    content:
                        `Ziel: ${goal}\n` +
                        `Minuten pro Tag: ${minutes}\n` +
                        `Wochen: ${weeks}\n` +
                        `Kategorien:\n${cats}\n` +
                        `Notizen:\n${ns}`
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
                        "Erstelle Multiple-Choice-Fragen aus den gelieferten " +
                        "Lerninhalten. Mische Themen bei mehreren Kategorien. " +
                        "Keine Trickfragen, genau eine Antwort richtig. " +
                        "Nur JSON."
                },
                {
                    role: "user",
                    content:
                        `Plan: ${planTitle}\n` +
                        `Ziel: ${goal}\n` +
                        `Anzahl: ${questionCount}\n` +
                        `Kategorien:\n${cats}\n` +
                        `Notizen:\n${ns}`
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
    console.log(
        `LearnFlow AI läuft auf 0.0.0.0:${PORT}`
    );
});
```
