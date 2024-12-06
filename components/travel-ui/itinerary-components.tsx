import React from 'react';

interface TransportPreferencesProps {
  currentTransport: string[];
  onUpdate?: (transport: string[]) => void;
}

export const TransportPreferences: React.FC<TransportPreferencesProps> = ({ currentTransport, onUpdate }) => {
  const transportModes = [
    { value: 'walking', label: 'Walking', icon: '🚶‍♂️' },
    { value: 'public', label: 'Public Transport', icon: '🚇' },
    { value: 'taxi', label: 'Taxi/Ride Share', icon: '🚕' },
    { value: 'bicycle', label: 'Bicycle', icon: '🚲' }
  ];

  return (
    <div className="w-full mb-3 max-w-[600px] bg-white rounded-3xl shadow-md">
      <div className="px-8 py-5">
        <h3 className="text-lg font-raleway font-semibold text-gray-700 mb-3">Transport Preferences</h3>
        <div className="grid grid-cols-2 gap-3">
          {transportModes.map(({ value, label, icon }) => (
            <button
              key={value}
              onClick={() => {
                const newTransport = currentTransport.includes(value)
                  ? currentTransport.filter(t => t !== value)
                  : [...currentTransport, value];
                onUpdate?.(newTransport);
              }}
              className={`
                px-4 py-3 rounded-lg font-raleway text-sm
                transition-all duration-200 ease-in-out
                ${currentTransport.includes(value)
                  ? 'bg-[#4798cc] bg-opacity-20 text-[#4798cc] shadow-sm'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }
              `}
            >
              <div className="flex flex-col items-center gap-1">
                <span className="text-xl">{icon}</span>
                <span className="font-medium">{label}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

interface DiningPreferencesProps {
  currentDining: string[];
  onUpdate?: (dining: string[]) => void;
}

export const DiningPreferences: React.FC<DiningPreferencesProps> = ({ currentDining, onUpdate }) => {
  const diningTypes = [
    { value: 'local', label: 'Local Cuisine', icon: '🍜' },
    { value: 'international', label: 'International', icon: '🌮' },
    { value: 'fine-dining', label: 'Fine Dining', icon: '🍽️' },
    { value: 'street-food', label: 'Street Food', icon: '🥘' },
    { value: 'vegetarian', label: 'Vegetarian', icon: '🥗' },
    { value: 'halal', label: 'Halal', icon: '🍖' }
  ];

  return (
    <div className="w-full mb-3 max-w-[600px] bg-white rounded-3xl shadow-md">
      <div className="px-8 py-5">
        <h3 className="text-lg font-raleway font-semibold text-gray-700 mb-3">Dining Preferences</h3>
        <div className="grid grid-cols-2 gap-3">
          {diningTypes.map(({ value, label, icon }) => (
            <button
              key={value}
              onClick={() => {
                const newDining = currentDining.includes(value)
                  ? currentDining.filter(d => d !== value)
                  : [...currentDining, value];
                onUpdate?.(newDining);
              }}
              className={`
                px-4 py-3 rounded-lg font-raleway text-sm
                transition-all duration-200 ease-in-out
                ${currentDining.includes(value)
                  ? 'bg-[#4798cc] bg-opacity-20 text-[#4798cc] shadow-sm'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }
              `}
            >
              <div className="flex flex-col items-center gap-1">
                <span className="text-xl">{icon}</span>
                <span className="font-medium">{label}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
