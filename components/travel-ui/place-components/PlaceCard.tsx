import React from 'react';
import { Place, getPlaceTypeDisplayName } from '../../../utils/places-utils';

interface PlaceCardProps {
  place: Place;
  onSelect?: (place: Place) => void;
  onRemove?: (placeId: string) => void;
  isSelected?: boolean;
  showActions?: boolean;
  className?: string;
}

export const PlaceCard: React.FC<PlaceCardProps> = ({
  place,
  onSelect,
  onRemove,
  isSelected = false,
  showActions = false,
  className = ''
}) => {
  // Get the display name with proper fallback
  const getTypeDisplay = () => {
    if (place.primaryTypeDisplayName?.text) {
      return place.primaryTypeDisplayName.text;
    }
    return getPlaceTypeDisplayName(place);
  };

  return (
    <div 
      className={`place-card w-full h-min rounded-lg overflow-hidden ${className}`}
    >
      <div className="bg-gray-200 h-48 flex items-center justify-center">
        {place.photos && place.photos.length > 0 ? (
          <img
            src={`https://places.googleapis.com/v1/${place.photos[0].name}/media?maxHeightPx=500&maxWidthPx=400&key=${process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}`}
            alt={place.displayName}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gray-300">
            <span className="text-gray-500">No image available</span>
          </div>
        )}
      </div>
      <div className="p-4 bg-white">
        <h3 className="text-lg font-bold text-gray-900">{place.displayName}</h3>
        <p className="text-sm text-gray-500 mb-3 font-medium">{getTypeDisplay()}</p>
        <p className="text-sm text-gray-600">{place.formattedAddress}</p>
      
        {showActions && (
          <div className="mt-4 flex justify-end gap-2">
            {!isSelected && onSelect && (
              <button
                onClick={() => onSelect(place)}
                className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 transition-colors duration-200"
                aria-label={`Select ${place.displayName}`}
              >
                Select
              </button>
            )}
            {onRemove && (
              <button
                onClick={() => onRemove(place.id)}
                className="px-4 py-2 bg-red-500 text-white rounded-md hover:bg-red-600 transition-colors duration-200"
                aria-label={`Remove ${place.displayName}`}
              >
                Remove
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};