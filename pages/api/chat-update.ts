import { createOpenAI } from '@ai-sdk/openai';
import { streamText } from 'ai';
import { NextRequest } from 'next/server';

// Create an OpenAI instance with custom settings
const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  compatibility: 'strict'  // Important: use strict mode for OpenAI API
});

// Set the runtime configuration
export const config = {
  runtime: 'edge',
  regions: ['default'],
};

export default async function handler(req: NextRequest) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {

    console.log('[chat-update] Received request');

    const { messages, currentDetails, componentUpdate } = await req.json();

    if (!messages || !Array.isArray(messages)) {
      return new Response(
        JSON.stringify({ error: 'Invalid request: messages array is required' }), 
        { 
          status: 400,
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Accept'
          }
        }
      );
    }

    if (!currentDetails) {
      return new Response(
        JSON.stringify({ error: 'Invalid request: currentDetails is required' }), 
        { 
          status: 400,
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Accept'
          }
        }
      );
    }

    const systemPrompt = componentUpdate 
      ? `You are a travel assistant helping with a trip to ${currentDetails.destination}. 
        The user has just updated their ${componentUpdate.type}. 
        Simply acknowledge this update in a brief, friendly way.

        IMPORTANT: Always respond in English regardless of the PDF export language setting.

        Response Rules:
        1. Keep response to 1-2 short sentence
        2. Only acknowledge the change, do not make suggestions
        3. If they update language preference, only acknowledge that it affects the final PDF export language - this does not change our conversation language`
      : `You are a travel assistant helping with a trip to ${currentDetails.destination}.
        IMPORTANT: Always respond in English regardless of the PDF export language setting.

        Current Details:
        - Dates: ${currentDetails.startDate} to ${currentDetails.endDate}
        - Budget: ${currentDetails.budget}
        - Preferences: ${currentDetails.preferences?.join(', ')}
        - PDF Export Language: ${currentDetails.language} (this setting only affects the final PDF generation, not our conversation)

        Response Rules:
        1. Keep responses concise and relevant
        2. Focus on answering user questions about their trip
        3. Always respond in English`;


    const result = await streamText({
      model: openai('gpt-4o'),
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages
      ],
      maxTokens: 150,
      temperature: 0.7
    });
      
    return new Response(result.textStream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      }
    });
  } catch (error) {
    console.error('[chat-update] Error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error', details: error.message }),
      { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}
