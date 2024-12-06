import { streamText } from 'ai';
import { Configuration, OpenAIApi } from 'openai-edge';
import { NextRequest, NextResponse } from 'next/server';

// Create an OpenAI API client
const config = new Configuration({
  apiKey: process.env.OPENAI_API_KEY
});
const openai = new OpenAIApi(config);

// Set the runtime to edge for best performance
export const runtime = 'edge';

export default async function handler(req: NextRequest) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const { messages } = await req.json();

    if (!messages || !Array.isArray(messages)) {
      return new Response('Invalid request: messages array is required', { status: 400 });
    }

    // Create a text stream using the OpenAI API
    const textStream = streamText({
      model: 'gpt-4',
      messages: messages.map((message: any) => ({
        content: message.content,
        role: message.role,
      })),
      temperature: 0.7,
      max_tokens: 800,
    });

    // Convert the stream to a response
    return textStream.toDataStreamResponse();
  } catch (error: any) {
    console.error('Chat API Error:', error);
    
    // Handle rate limit errors
    if (error.message?.includes('rate limit')) {
      return new Response('Rate limit exceeded. Please try again later.', { status: 429 });
    }

    // Handle other errors
    return new Response(
      'An error occurred while processing your request.',
      { status: 500 }
    );
  }
}
