export interface Control {
    lastStatus: string;
    lastAlertAt: string;
}

export interface IControlRepository {
    get(): Promise<Control | null>;
    update(control: Control): Promise<void>;
}
