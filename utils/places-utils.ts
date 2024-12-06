// Place related interfaces
export interface Place {
    id: string;
    displayName: string;
    formattedAddress?: string;
    location?: {
        latitude: number;
        longitude: number;
    };
    primaryType: string;
    primaryTypeDisplayName?: {
        text: string;
        languageCode: string;
    };
    photos?: { 
        name: string;
        widthPx?: number;
        heightPx?: number;
        authorAttributions?: Array<{
            displayName?: string;
            uri?: string;
            photoUri?: string;
        }>;
    }[];
}

// Updated preference to place types mapping based on travel-rizz.html
export const preferenceToPlaceTypes: Record<string, string[]> = {
    'Culture and Heritage': [
        'historical_landmark',
        'historical_place',
        'cultural_landmark',
        'cultural_center',
        'monument'
    ],
    'Nature': [
        'national_park',
        'park',
        'garden',
        'botanical_garden',
        'beach'
    ],
    'Foodie': [
        'restaurant',
        'cafe',
        'bakery',
        'food_court',
        'fine_dining_restaurant'
    ],
    'Leisure': [
        'shopping_mall',
        'plaza',
        'spa',
        'tourist_attraction',
        'marketplace'
    ],
    'Adventure': [
        'amusement_park',
        'adventure_sports_center',
        'sports_complex',
        'water_park',
        'hiking_area'
    ],
    'Arts and Museums': [
        'museum',
        'art_gallery',
        'art_studio',
        'performing_arts_theater',
        'concert_hall'
    ]
};

// Helper function to get place types based on preferences
export const getPlaceTypesFromPreferences = (preferences: string[]): string[] => {
    try {
        // Get unique types from all preferences
        const types = new Set(preferences.reduce((types: string[], pref) => {
            const placeTypes = preferenceToPlaceTypes[pref] || [];
            return [...types, ...placeTypes];
        }, []));

        return Array.from(types);
    } catch (error) {
        console.error('Error getting place types from preferences:', error);
        return ['tourist_attraction']; // Default fallback
    }
};

// Helper function to format primary type
export const formatPrimaryType = (type: string): string => {
    return type.split('_')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
};

// Helper function to get display name for place type
export const getPlaceTypeDisplayName = (place: any): string => {
    if (place?.primaryTypeDisplayName?.text) {
        return place.primaryTypeDisplayName.text;
    }
    // Fallback to formatting the primaryType if displayName is not available
    return place.primaryType ? formatPrimaryType(place.primaryType) : 'Place';
};

// Fetch places from Google Places API
export const fetchPlaces = async (
    latitude: number,
    longitude: number,
    preferences?: string[],
    maxResults: number = 10
): Promise<Place[]> => {
    try {
        const includedTypes = preferences ? 
            getPlaceTypesFromPreferences(preferences) : 
            ['tourist_attraction'];

        const requestBody = {
            includedTypes,
            maxResultCount: maxResults,
            locationRestriction: {
                circle: {
                    center: {
                        latitude,
                        longitude
                    },
                    radius: 20000.0 // 20km radius
                }
            }
        };

        const headers = new Headers({
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || '',
            'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.primaryType,places.primaryTypeDisplayName,places.photos'
        });

        const response = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            console.error('Failed to fetch places:', response.statusText);
            const errorData = await response.text();
            console.error('Error details:', errorData);
            return [];
        }

        const data = await response.json();
        
        // For debugging
        if (data.places?.length > 0) {
            console.log('Sample place data:', {
                name: data.places[0].displayName?.text,
                type: data.places[0].primaryType,
                typeDisplay: data.places[0].primaryTypeDisplayName
            });
        }
        
        return data.places ? data.places.map((place: any): Place => {
            const mappedPlace: Place = {
                id: place.id,
                displayName: place.displayName?.text || 'Unnamed Place',
                primaryType: place.primaryType || 'place',
                photos: place.photos?.map((photo: any) => ({ name: photo.name })) || [],
                formattedAddress: place.formattedAddress,
                location: place.location,
                primaryTypeDisplayName: place.primaryTypeDisplayName ? {
                    text: place.primaryTypeDisplayName.text,
                    languageCode: place.primaryTypeDisplayName.languageCode
                } : undefined
            };

            return mappedPlace;
        }) : [];
    } catch (error) {
        console.error('Error fetching places:', error);
        return [];
    }
};