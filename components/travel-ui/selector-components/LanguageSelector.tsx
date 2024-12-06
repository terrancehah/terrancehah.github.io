import React from 'react';

interface LanguageSelectorProps {
  currentLanguage: string;
  onUpdate?: (language: string) => void;
}

export const LanguageSelector: React.FC<LanguageSelectorProps> = ({ currentLanguage, onUpdate }) => {
  const languages = [
    'English', 'Malay (Bahasa Melayu)', 'Espanol', 'Francais', 'Deutsch', 'Italiano', 
    'Czech (Cestina)', 'Simplified Chinese (简体中文)', 'Traditional Chinese (繁體中文)', 'Japanese (日本語)', 'Korean (한국어)'
  ];

  return (
    <div className="w-full max-w-[600px] bg-white rounded-3xl shadow-md">
      <div className="px-8 py-5">
        <h3 className="text-lg font-raleway font-semibold text-gray-700 mb-3">Preferred Language</h3>
        <select
          value={currentLanguage}
          onChange={(e) => onUpdate?.(e.target.value)}
          className="w-full p-2 border rounded font-raleway text-gray-700"
        >
          {languages.map(lang => (
            <option key={lang} value={lang}>
              {lang}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
};
