import { EventEmitter } from 'events';
import { 
    ContentType,
    ContentParams,
    ContentResponse,
    CacheConfig,
    CacheEntry,
    SupportedLanguage,
    LANGUAGE_LABELS,
    SUPPORTED_LANGUAGES
} from './types';

export class AIContentManager extends EventEmitter {
    private cache: Map<string, CacheEntry>;
    private cacheConfig: CacheConfig;
    private contentTemplates: Map<ContentType, string>;
    private supportedLanguages: Set<SupportedLanguage>;
    private activeLanguages: Set<SupportedLanguage>;
    private contentCache: Map<string, string>;
    private translationCache: Map<string, Map<SupportedLanguage, string>>;
    private cleanupInterval: NodeJS.Timeout;

    constructor(config?: Partial<CacheConfig>) {
        super();
        this.cache = new Map();
        this.cacheConfig = {
            maxSize: config?.maxSize || 100,
            ttl: config?.ttl || 1800000 // 30 minutes default
        };
        this.contentTemplates = this.initializeTemplates();
        this.supportedLanguages = new Set(Object.keys(LANGUAGE_LABELS));
        this.activeLanguages = new Set<SupportedLanguage>(['en']);
        this.contentCache = new Map();
        this.translationCache = new Map();
        
        // Start periodic cache cleanup
        this.cleanupInterval = setInterval(() => {
            this.cleanupCache();
        }, 300000); // Clean every 5 minutes
    }

    private initializeTemplates(): Map<ContentType, string> {
        const templates = new Map();
        
        templates.set('travel_description', 
            'Discover {destination}, a {adjective} destination perfect for {focus}. ' +
            'With its {features}, visitors can enjoy {activities}.');
        
        templates.set('place_details',
            '{name} is a {type} known for {highlights}. ' +
            'Located in {location}, it offers {features}.');
        
        templates.set('itinerary',
            'Day {day}: Start your day at {morning_activity}, ' +
            'followed by {afternoon_activity}. ' +
            'End your day with {evening_activity}.');
        
        templates.set('travel_tips',
            'When visiting {destination}, remember to {important_tip}. ' +
            'Best times to visit are {best_times}, and don\'t forget to {reminder}.');
        
        return templates;
    }

    async generateContent(params: ContentParams): Promise<ContentResponse> {
        const cacheKey = this.generateCacheKey(params);
        const cachedContent = this.getCachedContent(cacheKey, params.language || 'en');

        if (cachedContent) {
            return {
                content: cachedContent.content,
                cached: true,
                language: cachedContent.language,
                generated: new Date(cachedContent.timestamp)
            };
        }

        try {
            const content = await this.createContent(params);
            const translatedContent = params.language && params.language !== 'en'
                ? await this.translateContent(content, params.language)
                : content;

            this.cacheContent(cacheKey, {
                content: translatedContent,
                timestamp: Date.now(),
                language: params.language || 'en'
            });

            return {
                content: translatedContent,
                cached: false,
                language: params.language || 'en',
                generated: new Date()
            };
        } catch (error) {
            console.error('Error generating content:', error);
            throw new Error('Failed to generate content');
        }
    }

    private async createContent(params: ContentParams): Promise<string> {
        const template = this.contentTemplates.get(params.type);
        if (!template) {
            throw new Error(`No template found for content type: ${params.type}`);
        }

        // Here you would typically call your AI service to generate content
        // For now, we'll use template-based generation
        let content = template;
        
        switch (params.type) {
            case 'travel_description':
                content = this.generateTravelDescription(params);
                break;
            case 'place_details':
                content = this.generatePlaceDetails(params);
                break;
            case 'itinerary':
                content = this.generateItinerary(params);
                break;
            default:
                content = this.generateGenericContent(params);
        }

        return this.formatContent(content, params.style || 'casual');
    }

    private generateTravelDescription(params: ContentParams): string {
        // Implementation would typically call an AI service
        // For now, return a template-based description
        return `Discover ${params.destination}, a fascinating destination perfect for ${
            params.focus?.join(' and ') || 'travelers'}. Experience the local culture, 
            cuisine, and attractions that make this place unique.`;
    }

    private generatePlaceDetails(params: ContentParams): string {
        const place = params.place;
        if (!place) return '';

        return `${place.displayName.text} is a ${place.primaryType || 'location'} 
            ${place.formattedAddress ? `located at ${place.formattedAddress}` : ''}.`;
    }

    private generateItinerary(params: ContentParams): string {
        // Implementation would typically call an AI service
        return `A perfect day in ${params.destination}: Start with breakfast at a local café, 
            explore the main attractions, and end your day with dinner at a recommended restaurant.`;
    }

    private generateGenericContent(params: ContentParams): string {
        return `Information about ${params.destination || 'your destination'} 
            will be provided based on your interests and preferences.`;
    }

    async translateContent(content: string, targetLanguage: SupportedLanguage): Promise<string> {
        if (!this.supportedLanguages.has(targetLanguage)) {
            throw new Error(`Language ${targetLanguage} is not supported`);
        }

        // Here you would typically call a translation service
        // For demonstration, we'll just return the original content
        this.emit('translationRequested', { 
            targetLanguage, 
            languageName: LANGUAGE_LABELS[targetLanguage] 
        });
        
        const cacheKey = this.getCacheKey(content);
        const translations = this.translationCache.get(cacheKey);
        
        if (translations?.has(targetLanguage)) {
            return translations.get(targetLanguage)!;
        }

        try {
            // Here we would normally call a translation service
            // For now, just return a placeholder
            const translated = `[${SUPPORTED_LANGUAGES[targetLanguage]}] ${content}`;
            
            if (!this.translationCache.has(cacheKey)) {
                this.translationCache.set(cacheKey, new Map());
            }
            this.translationCache.get(cacheKey)!.set(targetLanguage, translated);
            
            this.emit('contentTranslated', {
                original: content,
                translated,
                language: targetLanguage
            });
            
            return translated;
        } catch (error) {
            this.emit('error', error);
            throw error;
        }
    }

    formatContent(content: string, style: 'formal' | 'casual' | 'enthusiastic' = 'casual'): string {
        // Remove extra whitespace and normalize line breaks
        content = content.replace(/\s+/g, ' ').trim();
        
        // Apply style-specific formatting
        switch (style) {
            case 'formal':
                return this.formatFormalContent(content);
            case 'enthusiastic':
                return this.formatEnthusiasticContent(content);
            default:
                return this.formatCasualContent(content);
        }
    }

    private formatFormalContent(content: string): string {
        return content.replace(/!+/g, '.');
    }

    private formatCasualContent(content: string): string {
        return content;
    }

    private formatEnthusiasticContent(content: string): string {
        return content.replace(/\./g, '!');
    }

    public formatMessageContent(content: string): string {
        // Format the message content with proper line breaks and spacing
        return content
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .join('\n');
    }

    private generateCacheKey(params: ContentParams): string {
        const keyParts = [
            params.type,
            params.destination || '',
            params.place?.id || '',
            params.style || 'casual',
            params.length || 'brief',
            params.focus?.join(',') || ''
        ];
        return keyParts.join('::');
    }

    private getCachedContent(key: string, language: string): CacheEntry | null {
        const entry = this.cache.get(`${key}::${language}`);
        if (!entry) return null;

        // Check if entry has expired
        if (Date.now() - entry.timestamp > this.cacheConfig.ttl) {
            this.cache.delete(`${key}::${language}`);
            return null;
        }

        return entry;
    }

    private cacheContent(key: string, entry: CacheEntry): void {
        const fullKey = `${key}::${entry.language}`;
        
        // Remove oldest entries if cache is full
        if (this.cache.size >= this.cacheConfig.maxSize) {
            const oldestKey = Array.from(this.cache.keys())[0];
            this.cache.delete(oldestKey);
        }

        this.cache.set(fullKey, entry);
        this.emit('contentCached', { key: fullKey, entry });
    }

    private cleanupCache(): void {
        const now = Date.now();
        
        // Cleanup main cache
        for (const [key, entry] of this.cache.entries()) {
            if (now - entry.timestamp > this.cacheConfig.ttl) {
                this.cache.delete(key);
            }
        }
        
        // Enforce size limit
        if (this.cache.size > this.cacheConfig.maxSize) {
            const entriesToDelete = Array.from(this.cache.entries())
                .sort((a, b) => a[1].timestamp - b[1].timestamp)
                .slice(0, this.cache.size - this.cacheConfig.maxSize);
            
            for (const [key] of entriesToDelete) {
                this.cache.delete(key);
            }
        }

        // Cleanup translation cache with same TTL
        for (const [key, langMap] of this.translationCache.entries()) {
            let isEmpty = true;
            for (const [lang, entry] of langMap.entries()) {
                const cacheEntry = this.cache.get(entry);
                if (!cacheEntry || now - cacheEntry.timestamp > this.cacheConfig.ttl) {
                    langMap.delete(lang);
                } else {
                    isEmpty = false;
                }
            }
            if (isEmpty) {
                this.translationCache.delete(key);
            }
        }
    }

    clearCache(): void {
        this.cache.clear();
        this.contentCache.clear();
        this.translationCache.clear();
        this.emit('cacheCleared');
    }

    addLanguage(language: SupportedLanguage): void {
        this.activeLanguages.add(language);
        this.emit('languageAdded', language);
    }

    removeLanguage(language: SupportedLanguage): void {
        if (language !== 'en') {
            this.activeLanguages.delete(language);
            this.emit('languageRemoved', language);
        }
    }

    getActiveLanguages(): SupportedLanguage[] {
        return Array.from(this.activeLanguages);
    }

    private getCacheKey(content: string): string {
        return content.toLowerCase().trim();
    }

    public destroy(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
        this.removeAllListeners();
        this.cache.clear();
        this.contentCache.clear();
        this.translationCache.clear();
    }
}
