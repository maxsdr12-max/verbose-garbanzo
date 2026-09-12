import express from "express";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();
const app=express(); app.use(cors()); app.use(express.json({limit:"2mb"}));
const PORT=Number(process.env.PORT||8787), MODEL=process.env.GROQ_MODEL||"groq/compound", FALLBACK=process.env.GROQ_FALLBACK_MODEL||"qwen/qwen3.8-27b";
app.get("/health",(_req,res)=>res.json({ok:true,provider:"groq",model:MODEL,fallback:FALLBACK}));
async function groq(messages,schema){
 if(!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY fehlt. Lege server/.env an.");
 let lastError="";
 for(const model of [MODEL,FALLBACK]){
  try{
   const body={model,messages,temperature:.55,max_tokens:5000};
   if(model.startsWith("groq/")){body.response_format={type:"json_object"};body.messages=[...messages,{role:"system",content:`Antworte ausschließlich mit gültigem JSON passend zu diesem Schema: ${JSON.stringify(schema.schema)}`}];}
   else body.response_format={type:"json_schema",json_schema:schema};
   const r=await fetch("https://api.groq.com/openai/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${process.env.GROQ_API_KEY}`},body:JSON.stringify(body)});
   const text=await r.text();
   if(!r.ok){lastError=`${model} ${r.status}: ${text}`;continue}
   const data=JSON.parse(text),content=data?.choices?.[0]?.message?.content;if(!content){lastError=`${model}: keine Antwort`;continue}
   try{return JSON.parse(content)}catch(e){lastError=`${model}: ungültiges JSON`;continue}
  }catch(e){lastError=e.message||String(e)}
 }
 throw new Error(`AI-Modelle fehlgeschlagen. ${lastError}`);
}
app.post("/api/plan",async(req,res)=>{try{
 const{goal,minutes,weeks,categories=[],notes=[]}=req.body;
 const cats=categories.map(c=>`${c.name}: ${(c.noteTitles||[]).join(", ")}`).join("\n")||"Keine Kategorien.";
 const ns=notes.map(n=>`- ${n.title}: ${String(n.content||"").slice(0,1200)}`).join("\n")||"Keine Notizen.";
 const out=await groq([{role:"system",content:"Du bist LearnFlow, ein Lernplan-Assistent. Erstelle realistische Lernpläne aus Kategorien und Notizen. Nutze verschiedene Methoden wie verstehen, wiederholen, anwenden, erklären und testen. Nur JSON."},{role:"user",content:`Ziel: ${goal}\nMinuten pro Tag: ${minutes}\nWochen: ${weeks}\nKategorien:\n${cats}\nNotizen:\n${ns}`}],{name:"learnflow_plan",strict:true,schema:{type:"object",properties:{title:{type:"string"},summary:{type:"string"},weeks:{type:"array",items:{type:"object",properties:{week:{type:"integer"},focus:{type:"string"},tasks:{type:"array",items:{type:"object",properties:{title:{type:"string"},category:{type:"string"},minutes:{type:"integer"},type:{type:"string"}},required:["title","category","minutes","type"],additionalProperties:false}}},required:["week","focus","tasks"],additionalProperties:false}}},required:["title","summary","weeks"],additionalProperties:false}});
 res.json(out);
}catch(e){res.status(500).json({error:e.message||"AI-Fehler"})}});
app.post("/api/questions",async(req,res)=>{try{
 const{planTitle="",goal="",categories=[],notes=[],count=7}=req.body;
 const cats=categories.map(c=>`${c.name}: ${(c.noteTitles||[]).join(", ")}`).join("\n")||"Keine Kategorien.";
 const ns=notes.map(n=>`${n.title}: ${String(n.content||"").slice(0,1400)}`).join("\n")||"Keine Notizen.";
 const out=await groq([{role:"system",content:"Du bist ein intelligenter Lerncoach. Erstelle Multiple-Choice-Fragen aus den gelieferten Lerninhalten. Mische Themen bei mehreren Kategorien. Keine Trickfragen, genau eine Antwort richtig. Nur JSON."},{role:"user",content:`Plan: ${planTitle}\nZiel: ${goal}\nAnzahl: ${Math.min(10,Math.max(3,Number(count)||7))}\nKategorien:\n${cats}\nNotizen:\n${ns}`}],{name:"learnflow_questions",strict:true,schema:{type:"object",properties:{questions:{type:"array",items:{type:"object",properties:{question:{type:"string"},options:{type:"array",items:{type:"string"},minItems:4,maxItems:4},answer:{type:"integer",minimum:0,maximum:3},explanation:{type:"string"},category:{type:"string"},difficulty:{type:"string"}},required:["question","options","answer","explanation","category","difficulty"],additionalProperties:false}}},required:["questions"],additionalProperties:false}});
 res.json(out);
}catch(e){res.status(500).json({error:e.message||"AI-Fehler"})}});
app.listen(PORT,"127.0.0.1",()=>console.log(`LearnFlow AI läuft auf http://127.0.0.1:${PORT}`));