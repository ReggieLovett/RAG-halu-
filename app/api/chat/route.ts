import { NextResponse } from "next/server";

type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export async function POST(request: Request) {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { error: "GROQ_API_KEY is not configured. Add it to .env.local and restart the app." },
      { status: 500 }
    );
  }

  try {
    const body = (await request.json()) as { messages?: ChatMessage[] };
    const messages = body.messages;

    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: "At least one message is required." }, { status: 400 });
    }

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        messages,
        temperature: 0.7,
        max_tokens: 1024
      })
    });

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };

    if (!response.ok) {
      return NextResponse.json(
        { error: data.error?.message ?? "Groq could not complete the request." },
        { status: response.status }
      );
    }

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return NextResponse.json({ error: "Groq returned an empty response." }, { status: 502 });
    }

    return NextResponse.json({ message: content });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to reach Groq right now.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
