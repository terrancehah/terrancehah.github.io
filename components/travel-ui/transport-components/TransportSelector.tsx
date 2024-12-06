import React from 'react';

export interface TransportOption {
  id: string;
  name: string;
  icon: string;
  description: string;
  benefits: string[];
}

interface TransportSelectorProps {
  onMethodSelect: (method: string) => void;
  selectedMethod?: string;
  onError?: (error: Error) => void;
}

export const transportOptions: TransportOption[] = [
  {
    id: 'public',
    name: 'Public Transport',
    icon: '🚇',
    description: 'Bus, train, and subway',
    benefits: ['Cost-effective', 'Eco-friendly', 'Local experience']
  },
  {
    id: 'walking',
    name: 'Walking',
    icon: '🚶',
    description: 'Explore on foot',
    benefits: ['Free', 'Healthy', 'Best for sightseeing']
  },
  {
    id: 'taxi',
    name: 'Taxi',
    icon: '🚕',
    description: 'Cab or ride-sharing',
    benefits: ['Convenient', 'Door-to-door', 'Available 24/7']
  },
  {
    id: 'car',
    name: 'Car Rental',
    icon: '🚗',
    description: 'Self-drive option',
    benefits: ['Freedom to explore', 'Comfort', 'Good for groups']
  },
  {
    id: 'bicycle',
    name: 'Bicycle',
    icon: '🚲',
    description: 'Bike rental or sharing',
    benefits: ['Eco-friendly', 'Flexible', 'Fun way to explore']
  },
  {
    id: 'custom',
    name: 'Mix & Match',
    icon: '🔄',
    description: 'Combination of modes',
    benefits: ['Maximum flexibility', 'Best of all options', 'Adaptable']
  }
];

const handleSelect = (method: string, onMethodSelect: (method: string) => void, onError?: (error: Error) => void) => {
  try {
    onMethodSelect(method);
  } catch (error) {
    console.error('Error selecting transport method:', error);
    onError?.(new Error('Failed to select transport method. Please try again.'));
  }
};

export const TransportSelector: React.FC<TransportSelectorProps> = ({
  onMethodSelect,
  selectedMethod,
  onError
}) => {
  return (
    <div className="w-full max-w-[600px] bg-white rounded-3xl shadow-md">
      <div className="px-8 py-5">
        <h3 className="text-lg font-raleway font-semibold text-gray-700 mb-3">
          Choose Your Transport
        </h3>
        <p className="text-sm text-gray-500 mb-4">
          Select how you'd like to explore. Each option offers unique advantages.
        </p>
        
        <div className="grid grid-cols-2 gap-3">
          {transportOptions.map(option => {
            const isSelected = selectedMethod === option.id;
            return (
              <button
                key={option.id}
                onClick={() => handleSelect(option.id, onMethodSelect, onError)}
                className={`
                  relative p-4 rounded-xl border-2 transition-all duration-300
                  ${isSelected
                    ? 'border-blue-500 bg-blue-50 shadow-md'
                    : 'border-gray-200 hover:border-blue-200 hover:bg-gray-50'}
                `}
              >
                {isSelected && (
                  <div className="absolute top-2 right-2">
                    <span className="flex h-3 w-3">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-3 w-3 bg-blue-500"></span>
                    </span>
                  </div>
                )}
                <div className="text-2xl mb-2">{option.icon}</div>
                <div className="font-raleway font-medium text-gray-700">
                  {option.name}
                </div>
                <div className="text-sm text-gray-500 mt-1">
                  {option.description}
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {option.benefits.map((benefit, idx) => (
                    <span 
                      key={idx}
                      className="inline-block px-2 py-1 text-xs rounded-full bg-gray-100 text-gray-600"
                    >
                      {benefit}
                    </span>
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};
