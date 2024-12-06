import React, { useRef, useMemo, useEffect } from 'react';
import { Message } from 'ai';
import { AIComponentManager } from '../managers/ai-component-manager';
import { AIContentManager } from '../managers/ai-content-manager';
import { TravelDetails, ComponentType } from '../managers/types';
import { useTravelChat } from '../hooks/useTravelChat';
import DetailsCard from './travel-ui/DetailsCard';

const TravelChat = ({ initialDetails }: { initialDetails: TravelDetails }) => {
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const chatContainerRef = useRef<HTMLDivElement>(null);
    
    const componentManager = useMemo(() => new AIComponentManager(), []);
    const contentManager = useMemo(() => new AIContentManager(), []);

    const {
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
    } = useTravelChat({
        initialDetails,
        componentManager,
        contentManager
    });

    useEffect(() => {
        if (messagesEndRef.current) {
            messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [messages]);

    const handleQuickAction = (type: ComponentType) => {
        // Pass only the necessary UI props for the component
        const componentProps = {
            ...(type === 'preferenceSelector' ? { currentPreferences: currentDetails.preferences } : {}),
            ...(type === 'budgetSelector' ? { currentBudget: currentDetails.budget } : {}),
            ...(type === 'languageSelector' ? { currentLanguage: currentDetails.language } : {}),
            ...(type === 'datePicker' ? { 
                dates: currentDetails.dates,
                style: { maxWidth: '300px' }
            } : {})
        };

        handleToolResponse(type, componentProps);
    };

    return (
        <div className="flex flex-col h-[100vh]">
            {/* Header */}
            <div className="bg-white px-4 border-b border-gray-200 py-4">
                <h1 className="text-gray-900 text-xl text-left">
                    {currentDetails.destination} {currentDetails.startDate} to {currentDetails.endDate}
                </h1>
            </div>

            {/* Main Chat Area with Flex Grow */}
            <div className="flex-1 overflow-y-auto" ref={chatContainerRef}>
                {/* Messages */}
                <div className="flex gap-1 flex-col space-y-4 p-4">
                    {error && (
                        <div className="p-3 bg-red-50 rounded-lg">
                            <p className="text-red-600 text-sm">{error}</p>
                        </div>
                    )}

                    {messages.map((message: Message) => {
                        // If it's a component with no content, render it directly
                        if (message.content === '' && message.data?.toolName) {
                            return (
                                <div key={message.id}>
                                    {componentManager.renderComponent(
                                        message.data.toolName,
                                        message.data.componentProps
                                    )}
                                </div>
                            );
                        }

                        // For details card, render without message wrapping
                        if (message.role === 'system' && message.data?.isDetailsCard) {
                            return (
                                <div key={message.id} className="w-full bg-white rounded-3xl">
                                    {componentManager.renderComponent(
                                        message.data.toolName,
                                        message.data.componentProps
                                    )}
                                </div>
                            );
                        }

                        // Skip empty messages
                        if (!message.content.trim()) {
                            return null;
                        }

                        // For normal messages
                        return (
                            <div
                                key={message.id}
                                className={`flex ${
                                    message.role === 'user' ? 'justify-end' : 'justify-start'
                                }`}
                            >
                                <div
                                    className={`rounded-2xl px-4 py-2 max-w-[80%] shadow-md ${
                                        message.role === 'user'
                                            ? 'bg-white text-gray-800 text-left'
                                            : 'bg-white text-gray-800 text-left'
                                    } ${message.data?.isError ? 'border-red-500 border' : ''}`}
                                >
                                    {message.data?.isLoading ? (
                                        <div className="flex items-center space-x-2">
                                            <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" />
                                            <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce delay-100" />
                                            <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce delay-200" />
                                        </div>
                                    ) : (
                                        <p className="whitespace-pre-wrap break-words text-sm leading-normal">
                                            {message.content}
                                        </p>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                    <div ref={messagesEndRef} /> {/* Scroll anchor */}
                    
                    {/* Loading indicator */}
                    {isLoading && (
                        <div className="flex justify-start">
                            <div className="bg-gray-100 rounded-lg px-4 py-2">
                                <div className="animate-pulse">Thinking...</div>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Quick Action Buttons */}
            <div className="flex space-x-2 mx-4 mb-3">
                <button
                    onClick={() => handleQuickAction('datePicker')}
                    className="px-4 py-2 rounded-lg text-sm shadow-md bg-gray-100 hover:bg-gray-200"
                >
                    📅 Dates
                </button>
                <button
                    onClick={() => handleQuickAction('preferenceSelector')}
                    className="px-4 py-2 rounded-lg text-sm shadow-md bg-gray-100 hover:bg-gray-200"
                >
                    🎯 Preferences
                </button>
                <button
                    onClick={() => handleQuickAction('budgetSelector')}
                    className="px-4 py-2 rounded-lg text-sm shadow-md bg-gray-100 hover:bg-gray-200"
                >
                    💰 Budget
                </button>
                <button
                    onClick={() => handleQuickAction('languageSelector')}
                    className="px-4 py-2 rounded-lg text-sm shadow-md bg-gray-100 hover:bg-gray-200"
                >
                    🌐 Language
                </button>
            </div>

            {/* Chat Input */}
            <div className="border-t border-gray-200 bg-white p-4">
                <form onSubmit={handleSubmit} className="flex items-center gap-2">
                    <input
                        type="text"
                        value={input}
                        onChange={handleInputChange}
                        placeholder="Type your message..."
                        className="flex-1 rounded-lg border border-gray-300 p-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <button
                        type="submit"
                        disabled={isLoading}
                        className="bg-blue-500 text-white px-4 py-2 rounded-lg hover:bg-blue-600 disabled:opacity-50"
                    >
                        Send
                    </button>
                </form>
            </div>

            {/* Active Tool UI */}
            {activeToolUI && (
                <div className="border-t border-gray-200 p-4 bg-gray-50">
                    {activeToolUI}
                </div>
            )}
        </div>
    );
};

export default TravelChat;