import { useCallback, useState, useMemo, useEffect } from 'react';
import { useChat } from 'ai/react';
import { AIComponentManager } from '../managers/ai-component-manager';
import { AIContentManager } from '../managers/ai-content-manager';
import { AIChatManager } from '../managers/ai-chat-manager';
import {
    ComponentType,
    TravelDetails,
    MessageData,
    ExtendedMessage,
    ToolResponse
} from '../managers/types';

interface Message {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    data?: any;
}

interface UseTravelChatProps {
    initialDetails: TravelDetails;
    componentManager: AIComponentManager;
    contentManager: AIContentManager;
}

interface UseTravelChatReturn {
    messages: ExtendedMessage[];
    input: string;
    isLoading: boolean;
    error: string | null;
    activeToolUI: ComponentType | null;
    currentDetails: TravelDetails;
    handleInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    handleSubmit: (e: React.FormEvent<HTMLFormElement>) => Promise<void>;
    handleToolResponse: (toolName: ComponentType, componentProps: Partial<MessageData>) => Promise<void>;
    chatManager: AIChatManager;
}

export function useTravelChat({
    initialDetails,
    componentManager,
    contentManager
}: UseTravelChatProps): UseTravelChatReturn {
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [activeToolUI, setActiveToolUI] = useState<ComponentType | null>(null);
    const [input, setInput] = useState('');
    const [currentDetails, setCurrentDetails] = useState<TravelDetails>(initialDetails);
    const chatManager = useMemo(() => new AIChatManager(initialDetails), [initialDetails]);
    const [messages, setMessages] = useState<ExtendedMessage[]>([
        {
            id: 'init',
            role: 'system',
            content: '',
            data: {
                toolName: 'detailsCard',
                isDetailsCard: true,
                componentProps: {
                    content: {
                        title: 'Travel Details',
                        details: initialDetails
                    }
                }
            }
        }
    ]);
    const [componentLoading, setComponentLoading] = useState<string | null>(null);

    useEffect(() => {
        const onDetailsUpdated = (details: TravelDetails) => {
            setCurrentDetails(details);
            
            setMessages(prev => {
                const withoutDetailsCard = prev.filter(msg => !msg.data?.isDetailsCard);
                return [...withoutDetailsCard, {
                    id: Date.now().toString(),
                    role: 'system',
                    content: '',
                    data: {
                        toolName: 'detailsCard',
                        isDetailsCard: true,
                        componentProps: {
                            content: {
                                title: 'Travel Details',
                                details: details
                            }
                        }
                    }
                }];
            });
        };

        chatManager.on('detailsUpdated', onDetailsUpdated);
        return () => {
            chatManager.off('detailsUpdated', onDetailsUpdated);
        };
    }, [chatManager]);

    const addMessage = useCallback((newMessage: Message) => {
        setMessages(prevMessages => [
            ...prevMessages,
            {
                ...newMessage,
                content: chatManager.formatMessageContent(newMessage.content)
            }
        ]);
    }, [chatManager]);

    const sendMessage = async (message: string) => {
        try {
            // First add the user's message
            const userMessageId = `user-${Date.now()}`;
            setMessages(prev => [...prev, {
                id: userMessageId,
                role: 'user',
                content: message
            }]);

            // Then prepare for AI's response
            const aiMessageId = `ai-${Date.now()}`;
            setMessages(prev => [...prev, {
                id: aiMessageId,
                role: 'assistant',
                content: '',
                data: { isLoading: true }
            }]);

            const reader = await chatManager.sendMessage(message);
            
            await chatManager.processStreamingResponse(reader, (content) => {
                setMessages(prev => prev.map(msg =>
                    msg.id === aiMessageId
                    ? { 
                        ...msg, 
                        content: msg.content + content,
                        data: { isLoading: false } 
                    }
                    : msg
                ));
            });
        } catch (error) {
            setError(error instanceof Error ? error.message : 'An error occurred');
        }
    };

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (!input.trim()) return;

        setIsLoading(true);
        setError(null);

        try {
            await sendMessage(input);
            setInput('');
        } catch (error) {
            setError(error instanceof Error ? error.message : 'An error occurred');
        } finally {
            setIsLoading(false);
        }
    };

    const handleToolResponse = async (toolName: ComponentType, componentProps: Partial<MessageData>) => {
        console.log('[handleToolResponse] Starting with toolName:', toolName);
        setActiveToolUI(null);

        if (['datePicker', 'preferenceSelector', 'budgetSelector', 'languageSelector'].includes(toolName)) {
            try {
                // 1. UI Cleanup - Remove old components but keep details card
                setMessages(prev => prev.filter(msg => !msg.data?.toolName || msg.data.isDetailsCard));

                // 2. Add component with UI-specific props
                const componentId = Date.now().toString();
                console.log('[handleToolResponse] Added component with ID:', componentId);
                setMessages(prev => [...prev, {
                    id: componentId,
                    role: 'assistant',
                    content: '',
                    data: {
                        toolName,
                        componentProps: {
                            ...componentProps,
                            onUpdate: async (value: any) => {
                                console.log('[onUpdate] Starting with value:', value, 'for toolName:', toolName);
                                try {
                                    setComponentLoading(componentId);
                                    console.log('[onUpdate] Set component loading for ID:', componentId);

                                    setMessages(prev => {
                                        console.log('[onUpdate] Previous messages:', prev);
                                        return prev.filter(msg => !msg.data?.toolName || msg.data.isDetailsCard)
                                    });

                                    const updateMessage = chatManager.formatUpdateMessage(toolName, value);
                                    console.log('[onUpdate] Generated update message:', updateMessage);

                                    setMessages(prev => [...prev, {
                                        id: Date.now().toString(),
                                        role: 'user',
                                        content: updateMessage
                                    }]);
                                    console.log('[onUpdate] Added user message');
                            
                                    try {
                                        console.log('[onUpdate] Calling handleToolUpdate with:', toolName, value);

                                        const { reader } = await chatManager.handleToolUpdate(toolName, value);

                                        const streamMessageId = `tool-update-${Date.now()}`;
                                        setMessages(prev => [...prev, {
                                            id: streamMessageId,
                                            role: 'assistant',
                                            content: '',
                                            data: { isLoading: true }
                                        }]);
                            
                                        await chatManager.processStreamingResponse(reader, (content) => {
                                            setMessages(prev => prev.map(msg =>
                                                msg.id === streamMessageId
                                                    ? { 
                                                        ...msg, 
                                                        content: msg.content + content,
                                                        data: { isLoading: false } 
                                                    }
                                                    : msg
                                            ));
                                        });
                                    } catch (error) {
                                        if (error instanceof Error && error.message.includes('Failed to fetch')) {
                                            setMessages(prev => [...prev, {
                                                id: Date.now().toString(),
                                                role: 'assistant',
                                                content: 'Unable to connect to the server. Please check your internet connection and try again.',
                                                data: { isError: true }
                                            }]);
                                        } else {
                                            setMessages(prev => [...prev, {
                                                id: Date.now().toString(),
                                                role: 'assistant',
                                                content: 'An error occurred while processing your request. Please try again.',
                                                data: { isError: true }
                                            }]);
                                        }
                                        setError(error instanceof Error ? error.message : 'An error occurred');
                                    }
                                } finally {
                                    setComponentLoading(null);
                                }
                            }
                        }
                    }
                }]);
            } catch (error) {
                setError(error instanceof Error ? error.message : 'An error occurred');
            }
        }
    };

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setInput(e.target.value);
    };

    const updateAssistantMessage = (content: string) => {
        setMessages(prevMessages => {
            const lastMessage = prevMessages[prevMessages.length - 1];
            if (lastMessage && lastMessage.role === 'assistant') {
                return prevMessages.map(msg => 
                    msg.id === lastMessage.id ? { ...msg, content: msg.content + content } : msg
                );
            }
            return prevMessages;
        });
    };

    return {
        messages,
        input,
        isLoading,
        error,
        activeToolUI,
        currentDetails,
        handleInputChange,
        handleSubmit,
        handleToolResponse,
        chatManager
    };
}
