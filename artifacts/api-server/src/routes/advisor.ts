import { Router } from "express";
import { anthropic } from "@workspace/integrations-anthropic-ai";

const advisorRouter = Router();

interface ToolEntry {
  name: string;
  cat: string;
  desc: string;
  price: string;
  rel: string;
  url?: string;
}

advisorRouter.post("/advisor", async (req, res) => {
  try {
    const { query, tools, mode, budget } = req.body as {
      query: string;
      tools: ToolEntry[];
      mode?: "recommend" | "compare" | "stack";
      budget?: number | string;
    };

    if (!query || typeof query !== "string") {
      res.status(400).json({ error: "query is required" });
      return;
    }

    const toolsContext = Array.isArray(tools) && tools.length > 0
      ? tools.map(t => `• ${t.name} (${t.cat}, ${t.price}): ${t.desc}`).join("\n")
      : "No tools context provided.";

    const rawBudget = typeof budget === "number" ? budget : (budget !== undefined && budget !== null && String(budget).trim() !== "" ? parseFloat(String(budget)) : NaN);
    const budgetNum = Number.isFinite(rawBudget) && rawBudget >= 0 ? rawBudget : NaN;
    const hasBudget = Number.isFinite(budgetNum);
    const budgetLine = hasBudget
      ? (budgetNum === 0
          ? `\n\nHARD CONSTRAINT — The user has set a $0 monthly budget (FREE ONLY). You MUST only recommend tools that have a genuinely usable free tier or are 100% free for the user's stated goal. Do NOT include Paid-only tools. If a Paid tool with a sufficient free tier is included, explicitly note "Free tier only".`
          : `\n\nThe user's MONTHLY BUDGET for AI tools is approximately $${budgetNum} USD. Stay within or below this budget. Strongly prefer Free and Freemium tools, and only include Paid tools if they offer free tiers sufficient for the user's goal, or if the user's budget clearly allows it. When recommending Paid tools, mention typical entry-tier monthly cost.`)
      : "";
    const budgetUserLine = hasBudget ? `\nMonthly budget: $${budgetNum} USD${budgetNum === 0 ? " (FREE TOOLS ONLY)" : ""}` : "";

    let systemPrompt: string;
    let userMessage: string;

    if (mode === "stack") {
      systemPrompt = `You are an expert AI tool consultant for Okiru Consulting. The user has a multi-step business or workflow goal that requires a COMBINATION of tools working together (a "stack"). Recommend 3 to 6 tools from the provided list that cover the distinct roles needed. For each tool, name the role it plays in the stack.${budgetLine}

Format your response as STRICT JSON with this exact structure:
{
  "summary": "1-2 sentence overview of why this stack solves the user's goal",
  "estimatedMonthlyCost": "Approximate combined monthly cost range, e.g. '$0-30/mo' or '$45-120/mo'. Use '$0/mo (Free tiers)' when applicable.",
  "withinBudget": true,
  "stack": [
    {
      "role": "Short label for what this tool does in the stack (e.g. 'Content generation', 'CRM & invoicing', 'Order tracking')",
      "tool": "Exact tool name from the list",
      "why": "1-2 sentences on why this tool fits this role for this user",
      "monthlyCost": "Typical cost the user will pay, e.g. 'Free', 'Free tier', '$20/mo', '$15-30/mo'"
    }
  ],
  "notes": "Any practical setup notes, sequencing tips, or budget warnings (1-3 sentences). If a Paid tool was included that pushes the user over budget, flag it here."
}

Rules:
- The stack array MUST have 3-6 distinct tools, each filling a DIFFERENT role.
- Only recommend tools that appear in the provided list.
- If the user's budget cannot support their stated goal, set "withinBudget": false and explain in "notes".
- Output ONLY the JSON object, no preamble.`;
      userMessage = `The user wants to: "${query}"${budgetUserLine}\n\nAvailable tools:\n${toolsContext}`;
    } else if (mode === "compare") {
      systemPrompt = `You are an expert AI tool consultant for Okiru Consulting. The user is comparing specific tools. Give a concise, structured comparison and a clear recommendation. Be direct and practical.

Format your response as JSON with this exact structure:
{
  "comparison": [
    { "aspect": "Best for", "values": { "ToolA": "...", "ToolB": "..." } },
    { "aspect": "Strengths", "values": { "ToolA": "...", "ToolB": "..." } },
    { "aspect": "Weaknesses", "values": { "ToolA": "...", "ToolB": "..." } },
    { "aspect": "Pricing", "values": { "ToolA": "...", "ToolB": "..." } },
    { "aspect": "Learning curve", "values": { "ToolA": "...", "ToolB": "..." } }
  ],
  "winner": "ToolName",
  "winnerReason": "One sentence explaining why this is the best choice for the user's stated need.",
  "template": "A ready-to-use starter prompt or workflow for the winning tool (2-3 sentences)."
}`;

      userMessage = `The user wants to compare these tools for this goal: "${query}"\n\nTools to compare:\n${toolsContext}`;
    } else {
      systemPrompt = `You are an expert AI tool consultant for Okiru Consulting. Given the user's goal, recommend the single best tool from the provided list. Be specific, practical, and concise.${budgetLine}

Format your response as JSON with this exact structure:
{
  "tool": "Exact tool name from the list",
  "reason": "2-3 sentences explaining why this tool is the best fit for the user's specific goal",
  "template": "A ready-to-use prompt or workflow template the user can copy and use immediately in that tool (3-5 sentences, specific to their goal)",
  "alternatives": ["Tool2", "Tool3"],
  "alternativeReasons": ["Why Tool2 could also work", "Why Tool3 could also work"],
  "suggestedTemplates": [
    { "name": "Template name", "description": "What this template does", "prompt": "The actual template prompt text" },
    { "name": "Template name 2", "description": "What this template does", "prompt": "The actual template prompt text" }
  ]
}`;

      userMessage = `The user wants to: "${query}"${budgetUserLine}\n\nAvailable tools:\n${toolsContext}`;
    }

    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 8192,
      messages: [{ role: "user", content: userMessage }],
      system: systemPrompt,
    });

    const block = message.content[0];
    const rawText = block.type === "text" ? block.text : "";

    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      res.status(500).json({ error: "Failed to parse AI response", raw: rawText });
      return;
    }

    const parsed = JSON.parse(jsonMatch[0]);
    res.json({ result: parsed });
  } catch (err) {
    console.error("Advisor error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default advisorRouter;
