import React from 'react';

interface BudgetSelectorProps {
  currentBudget: string;
  onUpdate?: (budget: string) => void;
}

export const BudgetSelector: React.FC<BudgetSelectorProps> = ({ currentBudget, onUpdate }) => {
  const budgetLevels = [
    { value: '$', label: 'Budget', description: 'Basic accommodations and local food' },
    { value: '$$', label: 'Moderate', description: 'Mid-range hotels and restaurants' },
    { value: '$$$', label: 'Luxury', description: 'High-end hotels and fine dining' },
    { value: '$$$$', label: 'Ultra Luxury', description: 'Exclusive resorts and experiences' }
  ];

  return (
    <div className="w-full mb-3 max-w-[600px] bg-white rounded-3xl shadow-md">
      <div className="px-8 py-5">
        <h3 className="text-lg font-raleway font-semibold text-gray-700 mb-3">Budget Level</h3>
        <div className="grid grid-cols-2 gap-3">
          {budgetLevels.map(({ value, label, description }) => (
            <button
              key={value}
              onClick={() => onUpdate?.(value)}
              className={`
                px-4 py-3 rounded-lg font-raleway text-sm
                transition-all duration-200 ease-in-out
                ${currentBudget === value
                  ? 'bg-[#4798cc] bg-opacity-20 text-[#4798cc] shadow-sm'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }
              `}
            >
              <div className="flex flex-col items-center gap-1">
                <span className="font-medium">{label}</span>
                <span className="text-lg font-medium">{value}</span>
                <span className="text-xs opacity-75 text-center">{description}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
