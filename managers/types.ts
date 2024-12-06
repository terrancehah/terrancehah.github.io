import { Message as AiMessage, JSONValue } from 'ai';
import { Place } from '../utils/places-utils';

export interface TravelDetails {
    destination: string;
    destinationLat: number;
    destinationLng: number;
    startDate: string;
    endDate: string;
    preferences: TravelPreference[];
    budget: BudgetLevel;
    language: SupportedLanguage;
    transport: string[];
    dining: string[];
    displayName?: { text: string };
    primaryType?: string;
}

export type ComponentType =
    | 'datePicker'
    | 'preferenceSelector'
    | 'budgetSelector'
    | 'languageSelector'
    | 'transportSelector'
    | 'placeCard'
    | 'carousel'
    | 'detailsCard';

export type BudgetLevel = '$' | '$$' | '$$$' | '$$$$';

export type SupportedLanguage =
    | 'en'
    | 'ms'
    | 'es'
    | 'fr'
    | 'de'
    | 'it'
    | 'cs'
    | 'zh-CN'
    | 'zh-TW'
    | 'ja'
    | 'ko';

export type TravelPreference =
    | 'Culture and Heritage'
    | 'Nature'
    | 'Foodie'
    | 'Leisure'
    | 'Adventure'
    | 'Arts and Museums';

export const BUDGET_DESCRIPTIONS: Record<BudgetLevel, string> = {
    '$': 'Basic accommodations',
    '$$': 'Mid-range hotels',
    '$$$': 'Luxury experiences',
    '$$$$': 'Ultra-luxury resorts'
};

export const BUDGET_LEVELS: BudgetLevel[] = ['$', '$$', '$$$', '$$$$'];

export const LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
    'en': 'English',
    'ms': 'Malay',
    'es': 'Spanish',
    'fr': 'French',
    'de': 'German',
    'it': 'Italian',
    'cs': 'Czech',
    'zh-CN': 'Simplified Chinese',
    'zh-TW': 'Traditional Chinese',
    'ja': 'Japanese',
    'ko': 'Korean'
};

export const SUPPORTED_LANGUAGES: Record<SupportedLanguage, string> = {
    'en': 'English',
    'ms': 'Malay',
    'es': 'Spanish',
    'fr': 'French',
    'de': 'German',
    'it': 'Italian',
    'cs': 'Czech',
    'zh-CN': 'Simplified Chinese',
    'zh-TW': 'Traditional Chinese',
    'ja': 'Japanese',
    'ko': 'Korean'
};

export const PREFERENCE_ICONS: Record<TravelPreference, string> = {
    'Culture and Heritage': '🏛️',
    'Nature': '🌲',
    'Foodie': '🍜',
    'Leisure': '🌅',
    'Adventure': '🏃',
    'Arts and Museums': '🎨'
};

export const TRAVEL_PREFERENCES: TravelPreference[] = [
    'Culture and Heritage',
    'Nature',
    'Foodie',
    'Leisure',
    'Adventure',
    'Arts and Museums'
];

export interface MessageData {
    toolName?: ComponentType;
    componentProps?: any;
    isDetailsCard?: boolean;
}

export interface ComponentProps {
    datePicker: {
        dates?: { startDate: string; endDate: string };
        onUpdate?: (dates: { startDate: string; endDate: string }) => void;
        style?: React.CSSProperties;
    };
    preferenceSelector: {
        currentPreferences?: TravelPreference[];
        onUpdate?: (preferences: TravelPreference[]) => void;
    };
    budgetSelector: {
        currentBudget?: BudgetLevel;
        onUpdate?: (budget: BudgetLevel) => void;
    };
    languageSelector: {
        currentLanguage?: SupportedLanguage;
        onUpdate?: (language: SupportedLanguage) => void;
    };
    transportSelector: {
        selectedMethod?: string;
        onMethodSelect?: (method: string) => void;
    };
    placeCard: {
        place: Place;
        onSelect?: (place: Place) => void;
        isSelected?: boolean;
    };
    carousel: {
        places: Place[];
        onPlaceSelect?: (place: Place) => void;
    };
    detailsCard: {
        content: {
            title?: string;
            details: Partial<TravelDetails>;
        };
    };
}

export interface ChatMessage extends Omit<AiMessage, 'data'> {
    data?: MessageData;
}

export type ToolResponse<T extends ComponentType> = {
    type: T;
    props: ComponentProps[T];
    message?: string;
}

export interface ChatHistory {
    messages: ChatMessage[];
    metadata: ChatMetadata;
}

export interface ChatMetadata {
    lastInteractionTime: Date;
    currentState: ChatState;
    validParameters: string[];
    interruptedAt?: string;
}

export type ChatState = 'initial' | 'gathering_info' | 'planning' | 'interrupted' | 'completed';

export interface AIResponse {
    message: string;
    parameters?: TravelDetails;
    suggestedAction?: string;
    error?: string;
}

export interface ComponentRegistration<T extends ComponentType> {
    component: React.ComponentType<ComponentProps[T]>;
    defaultProps?: Partial<ComponentProps[T]>;
}

export interface ComponentState {
    id: string;
    type: ComponentType;
    props: any;
    isVisible: boolean;
    order: number;
}

export interface ComponentTransition {
    from?: ComponentType;
    to: ComponentType;
    animation?: string;
    duration?: number;
}

export interface ComponentUpdate {
    id: string;
    props?: any;
    isVisible?: boolean;
    order?: number;
}

export type ContentType = 
    | 'travel_description'
    | 'place_details'
    | 'itinerary'
    | 'travel_tips'
    | 'weather_info'
    | 'cultural_notes'
    | 'transport_info';

export interface ContentParams {
    type: ContentType;
    destination?: string;
    place?: Place;
    language?: string;
    style?: 'formal' | 'casual' | 'enthusiastic';
    length?: 'brief' | 'detailed' | 'comprehensive';
    focus?: string[];
}

export interface CacheConfig {
    maxSize: number;
    ttl: number; // Time to live in milliseconds
}

export interface CacheEntry {
    content: string;
    timestamp: number;
    language: string;
}

export interface ContentResponse {
    content: string;
    cached: boolean;
    language: string;
    generated: Date;
}
