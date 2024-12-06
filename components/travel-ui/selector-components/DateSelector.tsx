import React from 'react';
import flatpickr from 'flatpickr';
import 'flatpickr/dist/flatpickr.min.css';

interface DatePickerProps {
  startDate: string;
  endDate: string;
  onUpdate?: (dates: { startDate: string; endDate: string }) => void;
}

export const DatePicker: React.FC<DatePickerProps> = ({ startDate, endDate, onUpdate }) => {
  const dateInputRef = React.useRef<HTMLInputElement>(null);
  const [displayDates, setDisplayDates] = React.useState({
    startDate: startDate || '',
    endDate: endDate || ''
  });

  React.useEffect(() => {
    setDisplayDates({
      startDate: startDate || '',
      endDate: endDate || ''
    });
  }, [startDate, endDate]);

  React.useEffect(() => {
    if (dateInputRef.current) {
      const fp = flatpickr(dateInputRef.current, {
        mode: "range",
        dateFormat: "d-m-Y",
        defaultDate: [startDate, endDate],
        inline: true,
        minDate: "today",
        onChange: (selectedDates) => {
          if (selectedDates.length === 2) {
            const formatDate = (date: Date) => {
              const day = String(date.getDate()).padStart(2, '0');
              const month = String(date.getMonth() + 1).padStart(2, '0');
              const year = date.getFullYear();
              return `${day}-${month}-${year}`;
            };

            const newStartDate = formatDate(selectedDates[0]);
            const newEndDate = formatDate(selectedDates[1]);
            
            setDisplayDates({
              startDate: newStartDate,
              endDate: newEndDate
            });

            onUpdate?.({
              startDate: newStartDate,
              endDate: newEndDate
            });
          }
        }
      });

      return () => {
        fp.destroy();
      };
    }
  }, [startDate, endDate, onUpdate]);

  return (
    <div className="w-min max-w-[600px] mx-auto bg-white rounded-3xl shadow-md">
      <div className="px-8 py-5">
        <h3 className="text-lg font-raleway font-semibold text-gray-700 mb-3">Travel Dates</h3>
        
        {/* Date display box */}
        <div className="mb-4 p-3 bg-gray-50 rounded-lg text-center font-raleway text-gray-700">
          {displayDates.startDate && displayDates.endDate ? (
            <>
              <span>{displayDates.startDate}</span>
              <span className="mx-2">→</span>
              <span>{displayDates.endDate}</span>
            </>
          ) : (
            <span>Select your travel dates</span>
          )}
        </div>

        <div className="flex justify-center">
          <input 
            ref={dateInputRef}
            type="text"
            className="hidden"
          />
        </div>
      </div>
    </div>
  );
};
