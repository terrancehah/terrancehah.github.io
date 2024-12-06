import { EventEmitter } from 'events';
import React from 'react';
import { DatePicker } from '../components/travel-ui/selector-components/DateSelector';
import { PreferenceSelector } from '../components/travel-ui/selector-components/PreferenceSelector';
import { BudgetSelector } from '../components/travel-ui/selector-components/BudgetSelector';
import { LanguageSelector } from '../components/travel-ui/selector-components/LanguageSelector';
import { PlaceCard } from '../components/travel-ui/place-components/PlaceCard';
import { TransportSelector } from '../components/travel-ui/transport-components/TransportSelector';
import Carousel from '../components/travel-ui/place-components/PlaceCarousel';
import DetailsCard from '../components/travel-ui/DetailsCard';
import { 
    ComponentType,
    ComponentProps,
    ComponentRegistration,
    ToolResponse,
    BudgetLevel,
    TravelPreference,
    SupportedLanguage,
    BUDGET_DESCRIPTIONS,
    PREFERENCE_ICONS,
    LANGUAGE_LABELS,
    ComponentState
} from './types';

export class AIComponentManager extends EventEmitter {
    private componentRegistry: Map<ComponentType, ComponentRegistration<any>>;
    private activeComponents: Set<string>;
    private componentStates: Map<string, ComponentState>;

    constructor() {
        super();
        this.componentRegistry = this.initializeRegistry();
        this.activeComponents = new Set();
        this.componentStates = new Map();
    }

    public registerComponent<T extends ComponentType>(
        type: T,
        component: React.ComponentType<ComponentProps[T]>,
        defaultProps?: Partial<ComponentProps[T]>
    ): void {
        this.componentRegistry.set(type, {
            component,
            defaultProps
        });
    }

    public deregisterComponent(type: ComponentType): void {
        this.componentRegistry.delete(type);
        // Cleanup any active instances of this component type
        for (const [id, state] of this.componentStates.entries()) {
            if (state.type === type) {
                this.removeComponent(id);
            }
        }
    }

    public removeComponent(id: string): void {
        this.activeComponents.delete(id);
        this.componentStates.delete(id);
        this.emit('componentRemoved', id);
    }

    public handleToolResponse<T extends ComponentType>(response: ToolResponse<T>): void {
        try {
            const registration = this.componentRegistry.get(response.type);
            if (!registration) {
                throw new Error(`Component type ${response.type} not registered`);
            }

            const id = this.generateComponentId(response.type);
            const state: ComponentState = {
                id,
                type: response.type,
                props: {
                    ...registration.defaultProps,
                    ...response.props
                },
                isVisible: true,
                order: this.componentStates.size
            };

            this.componentStates.set(id, state);
            this.activeComponents.add(id);
            this.emit('componentAdded', state);

        } catch (error) {
            console.error('Error handling tool response:', error);
            this.emit('error', error);
        }
    }

    private generateComponentId(type: ComponentType): string {
        return `${type}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    public destroy(): void {
        this.removeAllListeners();
        this.activeComponents.clear();
        this.componentStates.clear();
        this.componentRegistry.clear();
    }

    private initializeRegistry(): Map<ComponentType, ComponentRegistration<any>> {
        const registry = new Map();

        registry.set('datePicker', {
            component: DatePicker,
            defaultProps: {
                onUpdate: (dates: { startDate: string; endDate: string }) => {
                    this.emit('dateUpdate', dates);
                }
            }
        });

        registry.set('preferenceSelector', {
            component: PreferenceSelector,
            defaultProps: {
                preferences: Object.keys(PREFERENCE_ICONS) as TravelPreference[],
                preferenceIcons: PREFERENCE_ICONS,
                onUpdate: (preferences: TravelPreference[]) => {
                    this.emit('preferencesUpdate', preferences);
                }
            }
        });

        registry.set('budgetSelector', {
            component: BudgetSelector,
            defaultProps: {
                options: Object.entries(BUDGET_DESCRIPTIONS).map(([value, label]) => ({
                    value: value as BudgetLevel,
                    label
                })),
                onUpdate: (budget: BudgetLevel) => {
                    this.emit('budgetUpdate', budget);
                }
            }
        });

        registry.set('languageSelector', {
            component: LanguageSelector,
            defaultProps: {
                languages: Object.entries(LANGUAGE_LABELS).map(([code, name]) => ({
                    code: code as SupportedLanguage,
                    name
                })),
                onUpdate: (language: SupportedLanguage) => {
                    this.emit('languageUpdate', language);
                }
            }
        });

        registry.set('placeCard', {
            component: PlaceCard,
            defaultProps: {
                onSelect: (place: any) => {
                    this.emit('placeSelect', place);
                }
            }
        });

        registry.set('carousel', {
            component: Carousel,
            defaultProps: {
                onPlaceSelect: (place: any) => {
                    this.emit('placeSelect', place);
                }
            }
        });

        registry.set('detailsCard', {
            component: DetailsCard,
            defaultProps: {
                onClose: () => {
                    this.emit('detailsClose');
                }
            }
        });

        registry.set('transportSelector', {
            component: TransportSelector,
            defaultProps: {
                onMethodSelect: (method: string) => {
                    this.emit('transportUpdate', method);
                }
            }
        });

        return registry;
    }

    renderComponent<T extends ComponentType>(
        type: T,
        props: Partial<ComponentProps[T]>
    ): JSX.Element {
        const registration = this.componentRegistry.get(type);
        if (!registration) {
            throw new Error(`Component type "${type}" not registered`);
        }

        const { component: Component, defaultProps } = registration;
        const mergedProps = {
            ...defaultProps,
            ...props
        };

        return React.createElement(Component, {
            key: `${type}-${Date.now()}`,
            ...mergedProps
        });
    }

    getRegisteredComponents(): ComponentType[] {
        return Array.from(this.componentRegistry.keys());
    }
}
