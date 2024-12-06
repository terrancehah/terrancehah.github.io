import React, { useEffect, useRef, useState } from 'react';
import Script from 'next/script';

interface MapComponentProps {
    city: string;
    apiKey: string;
}

declare global {
    interface Window {
        google: typeof google;
        initMap: () => void;
    }
}

const MapComponent: React.FC<MapComponentProps> = ({ city, apiKey }) => {
    const mapRef = useRef<HTMLDivElement | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [scriptLoaded, setScriptLoaded] = useState(false);

    useEffect(() => {
        if (!scriptLoaded || !mapRef.current) {
            console.log('Waiting for script to load or map ref to be ready...');
            return;
        }

        console.log('Initializing map with city:', city);
        const initMap = async () => {
            try {
                const geocoder = new window.google.maps.Geocoder();

                geocoder.geocode(
                    { address: city },
                    (results, status) => {
                        console.log('Geocoding response:', { status, resultsLength: results?.length });

                        if (status !== 'OK' || !results?.[0]?.geometry?.location) {
                            console.error('Geocoding failed:', status);
                            setError(`Could not find location for ${city}`);
                            setIsLoading(false);
                            return;
                        }

                        try {
                            const location = results[0].geometry.location;
                            console.log('Location found:', {
                                lat: location.lat(),
                                lng: location.lng()
                            });

                            const map = new window.google.maps.Map(mapRef.current!, {
                                center: location,
                                zoom: 13,
                                mapTypeControl: true,
                                streetViewControl: true,
                                fullscreenControl: true,
                                zoomControl: true,
                            });

                            new window.google.maps.Marker({
                                map,
                                position: location,
                                title: city,
                            });

                            setIsLoading(false);
                        } catch (err) {
                            console.error('Error creating map:', err);
                            setError('Failed to create map');
                            setIsLoading(false);
                        }
                    }
                );
            } catch (err) {
                console.error('Error in map initialization:', err);
                setError('Failed to initialize map');
                setIsLoading(false);
            }
        };

        initMap();
    }, [city, scriptLoaded]);

    return (
        <div className="relative w-full h-full">
            <Script
                src={`https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places`}
                strategy="lazyOnload"
                onLoad={() => {
                    console.log('Google Maps script loaded successfully');
                    setScriptLoaded(true);
                }}
                onError={(e) => {
                    console.error('Failed to load Google Maps script:', e);
                    setError('Failed to load Google Maps');
                    setIsLoading(false);
                }}
            />
            <div 
                ref={mapRef} 
                className="w-full h-full"
                style={{ minHeight: '400px' }}
            />
            {isLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-white bg-opacity-75">
                    <div className="text-gray-600">Loading map...</div>
                </div>
            )}
            {error && (
                <div className="absolute inset-0 flex items-center justify-center bg-white bg-opacity-75">
                    <div className="text-red-500">{error}</div>
                </div>
            )}
        </div>
    );
};

export default MapComponent;