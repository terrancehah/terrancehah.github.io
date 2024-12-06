import React from 'react';
import { TravelPreference } from '../../../managers/types';

interface PreferenceSelectorProps {
  currentPreferences?: TravelPreference[];
  onUpdate?: (preferences: TravelPreference[]) => void;
}

export const PreferenceSelector: React.FC<PreferenceSelectorProps> = ({ 
  currentPreferences = [], 
  onUpdate 
}) => {
  const allPreferences: TravelPreference[] = [
    'Culture and Heritage',
    'Nature',
    'Foodie',
    'Leisure',
    'Adventure',
    'Arts and Museums'
  ];

  const [tempPreferences, setTempPreferences] = React.useState<TravelPreference[]>(() => {
    // Ensure initial preferences are valid TravelPreference values
    return (currentPreferences || []).filter((pref): pref is TravelPreference => 
      allPreferences.includes(pref)
    );
  });

  // Update tempPreferences when currentPreferences changes
  React.useEffect(() => {
    console.log('Current preferences updated:', currentPreferences); // Debug log
    // Filter out any invalid preferences
    const validPreferences = (currentPreferences || []).filter((pref): pref is TravelPreference => 
      allPreferences.includes(pref)
    );
    setTempPreferences(validPreferences);
  }, [currentPreferences]);

  const handleConfirm = () => {
    console.log('Confirming preferences:', tempPreferences); // Debug log
    onUpdate?.(tempPreferences);
  };

  const togglePreference = (pref: TravelPreference) => {
    setTempPreferences(prev => {
      const newPrefs = prev.includes(pref)
        ? prev.filter(p => p !== pref)
        : [...prev, pref];
      console.log('Toggled preferences:', newPrefs); // Debug log
      return newPrefs;
    });
  };

  return (
    <div className="w-full mb-3 max-w-[600px] bg-white rounded-3xl shadow-md">
      <div className="px-6 py-4">
        <h3 className="text-lg font-raleway font-semibold text-gray-700 mb-3">Travel Preferences</h3>
        <div className="grid grid-cols-2 gap-3 mb-4">
          {allPreferences.map(pref => (
            <div 
              key={pref}
              onClick={() => togglePreference(pref)}
              className={`
                cursor-pointer flex align-middle text-left p-3 rounded-lg font-raleway text-sm
                transition-all duration-200 ease-in-out
                ${tempPreferences.includes(pref)
                  ? 'bg-[#4798cc] bg-opacity-20 text-[#4798cc] shadow-sm'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }
              `}
            >
              <div className="flex items-center gap-2">
                <div className={`
                  min-w-4 h-4 rounded border flex items-center justify-center
                  ${tempPreferences.includes(pref)
                    ? 'border-[#4798cc] bg-[#4798cc]'
                    : 'border-gray-300 bg-white'
                  }
                `}>
                  {tempPreferences.includes(pref) && (
                    <svg className="w-3 h-3 text-white" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  )}
                </div>
                <span>{pref}</span>
              </div>
            </div>
          ))}
        </div>
        <div className="flex justify-center">
          <button
            onClick={handleConfirm}
            className="px-6 py-2 bg-[#4798cc] text-white rounded-lg font-raleway hover:bg-[#3787bb] transition-colors"
          >
            Confirm Selection
          </button>
        </div>
      </div>
    </div>
  );
};
