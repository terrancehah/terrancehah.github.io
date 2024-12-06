import React from 'react';
import { TravelDetails } from '../../managers/types';

interface DetailsCardProps {
    content: {
        title?: string;
        details: Partial<TravelDetails>;
    };
}

const DetailsCard: React.FC<DetailsCardProps> = ({ content }) => {
    const { details } = content;
    
    return (
        <div className="w-full flex justify-center">
            <div className="details-card max-w-[70%] justify-center rounded-3xl bg-light-blue p-4">
                {details.destination && (
                    <p className="text-xs text-gray-700 mb-1">
                        <strong>Destination:</strong> {details.destination}
                    </p>
                )}
                {details.startDate && details.endDate && (
                    <p className="text-xs text-gray-700 mb-1">
                        <strong>Dates:</strong> {details.startDate} to {details.endDate}
                    </p>
                )}
                {details.budget && (
                    <p className="text-xs text-gray-700 mb-1">
                        <strong>Budget:</strong> {details.budget}
                    </p>
                )}
                {details.preferences && details.preferences.length > 0 && (
                    <p className="text-xs text-gray-700 mb-1">
                        <strong>Preferences:</strong> {details.preferences.join(', ')}
                    </p>
                )}
                {details.language && (
                    <p className="text-xs text-gray-700 mb-1">
                        <strong>Language:</strong> {details.language}
                    </p>
                )}
                {details.transport && details.transport.length > 0 && (
                    <p className="text-xs text-gray-700 mb-1">
                        <strong>Transport:</strong> {details.transport.join(', ')}
                    </p>
                )}
            </div>
        </div>
    );
};

export default DetailsCard;
