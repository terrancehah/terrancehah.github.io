import { EventEmitter } from 'events';
import { 
    ChatHistory, 
    ChatMessage, 
    ChatState, 
    TravelParameters,
    AIResponse,
    MessageData,
    BudgetLevel,
    TravelPreference,
    SupportedLanguage,
    TravelDetails,
    ComponentType
} from './types';

export class AIChatManager extends EventEmitter {
    private chatHistory: ChatHistory;
    private requiredParameters: Set<string>;
    private maxHistoryLength: number;
    private currentDetails: TravelDetails;

    constructor(initialDetails: TravelDetails) {
        super();
        this.chatHistory = this.initializeChatHistory();
        this.currentDetails = initialDetails;
        this.requiredParameters = new Set([
            'destination',
            'startDate',
            'endDate',
            'budget',
            'language'
        ]);
        this.maxHistoryLength = 50;
    }

    private initializeChatHistory(): ChatHistory {
        return {
            messages: [],
            metadata: {
                lastInteractionTime: new Date(),
                currentState: 'initial',
                validParameters: []
            }
        };
    }

    async handleMessage(message: string): Promise<AIResponse> {
        try {
            // Add user message to history
            this.addMessage({
                id: Date.now().toString(),
                role: 'user',
                content: message
            });

            // Process message and update parameters
            const response = await this.processMessage(message);
            
            // Add AI response to history
            this.addMessage({
                id: (Date.now() + 1).toString(),
                role: 'assistant',
                content: response.message,
                data: {
                    currentDetails: response.parameters
                }
            });

            return response;
        } catch (error) {
            console.error('Error handling message:', error);
            return {
                message: 'I encountered an error processing your message. Let\'s continue from where we left off.',
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    private async processMessage(message: string): Promise<AIResponse> {
        const currentState = this.chatHistory.metadata.currentState;
        
        if (currentState === 'interrupted') {
            return this.recoverConversation();
        }

        // Update state based on message content and current parameters
        const updatedParameters = await this.extractParameters(message);
        const validationResult = this.validateParameters(updatedParameters);

        if (validationResult.isValid) {
            this.updateState('planning');
            return {
                message: 'Great! I have all the information needed. Let me plan your trip.',
                parameters: updatedParameters
            };
        }

        return {
            message: `Could you please provide your ${validationResult.missingParams.join(', ')}?`,
            parameters: updatedParameters,
            suggestedAction: 'gather_info'
        };
    }

    private validateParameters(parameters: TravelParameters): { 
        isValid: boolean; 
        missingParams: string[];
        invalidParams: string[];
    } {
        const missingParams = Array.from(this.requiredParameters)
            .filter(param => !parameters[param as keyof TravelParameters]);

        const invalidParams: string[] = [];

        // Validate budget format
        if (parameters.budget && !['$', '$$', '$$$', '$$$$'].includes(parameters.budget)) {
            invalidParams.push('budget');
        }

        // Validate language
        if (parameters.language && !Object.keys(SupportedLanguage).includes(parameters.language)) {
            invalidParams.push('language');
        }

        // Validate preferences
        if (parameters.preferences?.some(pref => 
            !['Culture and Heritage', 'Nature', 'Foodie', 'Leisure', 'Adventure', 'Arts and Museums']
            .includes(pref))) {
            invalidParams.push('preferences');
        }

        return {
            isValid: missingParams.length === 0 && invalidParams.length === 0,
            missingParams,
            invalidParams
        };
    }

    private async extractParameters(message: string): Promise<TravelParameters> {
        // Implement NLP or pattern matching logic to extract parameters
        // For now, return current parameters
        const currentDetails = this.getCurrentParameters();
        return {
            ...currentDetails
        };
    }

    private addMessage(message: ChatMessage): void {
        this.chatHistory.messages.push(message);
        this.chatHistory.metadata.lastInteractionTime = new Date();
        
        // Trim history if it exceeds maxHistoryLength
        if (this.chatHistory.messages.length > this.maxHistoryLength) {
            this.chatHistory.messages = this.chatHistory.messages.slice(-this.maxHistoryLength);
        }

        this.emit('messageAdded', message);
    }

    getContextHistory(): ChatHistory {
        return this.chatHistory;
    }

    getCurrentParameters(): TravelParameters {
        const lastMessage = this.chatHistory.messages
            .reverse()
            .find(msg => msg.data?.currentDetails);
        
        return lastMessage?.data?.currentDetails || {};
    }

    private updateState(newState: ChatState): void {
        this.chatHistory.metadata.currentState = newState;
        this.emit('stateChanged', newState);
    }

    async recoverConversation(): Promise<AIResponse> {
        const currentParams = this.getCurrentParameters();
        const validationResult = this.validateParameters(currentParams);

        this.updateState('gathering_info');

        return {
            message: 'Let me help you get back on track. ' +
                    (validationResult.missingParams.length > 0 
                        ? `I still need your ${validationResult.missingParams.join(', ')}.`
                        : 'We were about to start planning your trip.'),
            parameters: currentParams
        };
    }

    clearHistory(): void {
        this.chatHistory = this.initializeChatHistory();
        this.emit('historyCleared');
    }

    public formatMessageContent(content: string): string {
        if (!content) return '';
        
        // Remove excessive newlines
        const trimmedContent = content.replace(/\n{3,}/g, '\n\n');
        
        // Ensure proper spacing around special characters
        return trimmedContent
            .replace(/([.!?])\s*(?=\S)/g, '$1 ')  // Add space after punctuation if missing
            .trim();
    }

    public updateSystemContext(details: TravelParameters): void {
        const systemMessage = this.chatHistory.messages.find(m => m.role === 'system');
        if (systemMessage) {
            systemMessage.content = `You are a knowledgeable travel assistant. Your role is to help users plan their trips by:
1. Understanding and remembering their travel preferences, dates, and budget
2. Providing detailed information about their chosen destination
3. Making suggestions based on their interests and constraints

Current Travel Details:
- Destination: ${details.destination || 'Not specified'}
- Dates: ${details.startDate ? `${details.startDate} to ${details.endDate}` : 'Not specified'}
- Budget Level: ${details.budget || 'Not specified'}
- Language: ${details.language || 'Not specified'}
- Preferences: ${details.preferences?.join(', ') || 'Not specified'}

Keep this context in mind throughout the conversation. If any detail changes, update your knowledge accordingly.
When providing information about destinations, include key attractions, local culture, best times to visit, and relevant travel tips.`;
        }
        this.emit('contextUpdated', this.chatHistory);
    }

    private handleFunctionCall(functionName: string, args: any): void {
        switch (functionName) {
            case 'getDetails':
                this.emit('getDetails');
                break;
            case 'updatePreferences':
                this.emit('updatePreferences', args.prefs);
                break;
            case 'updateDates':
                this.emit('updateDates', args.start, args.end);
                break;
            case 'updateBudget':
                this.emit('updateBudget', args.level);
                break;
            case 'updateLanguage':
                this.emit('updateLanguage', args.lang);
                break;
            default:
                console.warn(`Unknown function call: ${functionName}`);
        }
    }

    public processAIResponse(response: string): void {
        // Check for function calls in the response
        const functionCallRegex = /\b(getDetails|updatePreferences|updateDates|updateBudget|updateLanguage)\((.*?)\)/g;
        let match;

        while ((match = functionCallRegex.exec(response)) !== null) {
            const [_, functionName, argsStr] = match;
            try {
                const args = argsStr ? JSON.parse(`{${argsStr}}`) : {};
                this.handleFunctionCall(functionName, args);
            } catch (error) {
                console.error(`Error processing function call: ${error}`);
            }
        }
    }

    public async sendMessage(message: string): Promise<ReadableStreamDefaultReader<Uint8Array>> {

        const response = await fetch('/api/chat-update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                messages: this.chatHistory.messages,
                currentDetails: this.currentDetails,
                componentUpdate: null
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || 'Failed to get response');
        }

        const reader = response.body?.getReader();
        if (!reader) {
            throw new Error('No response body');
        }

        return reader;
    }

    public updateDetails(details: Partial<TravelDetails>): void {
        this.currentDetails = { ...this.currentDetails, ...details };
        this.emit('detailsUpdated', this.currentDetails);
    }

    public getCurrentDetails(): TravelDetails {
        return this.currentDetails;
    }

    public async handleToolUpdate(
        toolName: ComponentType,
        value: any
    ): Promise<{
        updatedDetails: TravelDetails;
        reader: ReadableStreamDefaultReader<Uint8Array>;
    }> {
        try {
            // Log the start of the operation
            console.log('[handleToolUpdate] Starting update...', { toolName, value });
    
            // Update details based on tool type
            const updatedDetails = {
                ...this.currentDetails,
                ...(toolName === 'budgetSelector' ? { budget: value } : {}),
                ...(toolName === 'preferenceSelector' ? { preferences: value } : {}),
                ...(toolName === 'languageSelector' ? { language: value } : {}),
                ...(toolName === 'datePicker' ? { 
                    startDate: value.startDate,
                    endDate: value.endDate 
                } : {})
            };

    
            // Log the request preparation
            console.log('[handleToolUpdate] Preparing request with:', { 
                type: toolName, 
                value, 
                details: updatedDetails 
            });

            // Use the formatted message for the request
            const formattedMessage = this.formatUpdateMessage(toolName, value);
    
            // Simplified request body
            const requestBody = {
                messages: [{
                    role: 'user',
                    content: formattedMessage
                }],
                currentDetails: updatedDetails,
                componentUpdate: { 
                    type: toolName, 
                    value
                }
            };
    
            // Make the request
            console.log('[handleToolUpdate] Making API request...');
            const response = await fetch('/api/chat-update', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });
    
            console.log('[handleToolUpdate] Response received:', response.status);
    
            if (!response.ok) {
                throw new Error(`API returned ${response.status}`);
            }
    
            const reader = response.body?.getReader();
            if (!reader) {
                throw new Error('No response body available');
            }
    
            console.log('[handleToolUpdate] Got reader successfully');
            this.currentDetails = updatedDetails;
            this.emit('detailsUpdated', updatedDetails);
    
            return { updatedDetails, reader };
        } catch (error) {
            console.error('[handleToolUpdate] Error:', error);
            throw error;
        }
    }

    public formatUpdateMessage(toolName: ComponentType, value: any): string {
        switch (toolName) {
            case 'datePicker':
                return `I've selected these travel dates: ${value.startDate} to ${value.endDate}`;
            case 'preferenceSelector':
                return `I've updated my travel preferences to: ${Array.isArray(value) ? value.join(', ') : value}`;
            case 'budgetSelector':
                return `I've set my travel budget to: ${value}`;
            case 'languageSelector':
                return `I'd like the PDF export in this language: ${value}`;
            default:
                return `I've updated my ${toolName.replace(/([A-Z])/g, ' $1').toLowerCase()} to: ${Array.isArray(value) ? value.join(', ') : value}`;
        }
    }

    public async processStreamingResponse(
        reader: ReadableStreamDefaultReader<Uint8Array>,
        onChunk: (content: string) => void
    ): Promise<void> {
        console.log('[processStreamingResponse] Starting to process stream');
        const decoder = new TextDecoder();
        let accumulatedContent = '';
        let currentMessage = this.chatHistory.messages[this.chatHistory.messages.length - 1];
    
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    console.log('[processStreamingResponse] Stream complete');
                    break;
                }
    
                const text = decoder.decode(value, { stream: true });
                console.log('[processStreamingResponse] Text chunk received:', text);
                
                onChunk(text);  // Send the chunk
            }
    
            if (currentMessage) {
                console.log('[processStreamingResponse] Final message:', currentMessage.content);
                this.processAIResponse(currentMessage.content);
            }
    
            this.emit('messageUpdated', currentMessage);
        } catch (error) {
            console.error('[processStreamingResponse] Stream processing error:', error);
            throw error;
        } finally {
            console.log('[processStreamingResponse] Cleaning up stream');
            reader.releaseLock();
        }
    }
}
