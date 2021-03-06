/********************************************************************************
 * Copyright (C) 2020. Huawei Technologies Co., Ltd. All rights reserved.
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cloudide from '@cloudide/plugin';
import * as path from 'path';
import * as fs from 'fs';
import * as cheerio from 'cheerio';
import { v4 as uuid } from 'uuid';
import { IframeLike, messaging, exposable, Deferred, expose, call, Messaging } from '@cloudide/messaging';
import { WebviewOptions } from '../common/plugin-common';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageJson = require('../../package.json');

export abstract class AbstractBackend {
    protected plugin: Plugin;
    protected context: cloudide.ExtensionContext;
    constructor(plugin: Plugin, context: cloudide.ExtensionContext) {
        this.plugin = plugin;
        this.context = context;
    }
    abstract async init(): Promise<void>;
    abstract run(): void;
    abstract stop(): void;
}

const beforeUninstallEventType = 'cloudide.plugin.beforeUninstall';

interface IBackendConstructor<T> extends Function {
    new (plugin: Plugin, context: cloudide.ExtensionContext): T;
}

export class Plugin {
    private static instance: Plugin;
    readonly pageInitialized: Deferred<boolean> = new Deferred<boolean>();
    private readonly isReady: Deferred<boolean> = new Deferred<boolean>();
    private _container: PluginContainerPanel;
    private _options: WebviewOptions;
    private backends: Map<IBackendConstructor<AbstractBackend>, AbstractBackend>;

    private constructor(pluginContainerPanel: PluginContainerPanel, backends: IBackendConstructor<AbstractBackend>[]) {
        this._container = pluginContainerPanel;
        this._options = pluginContainerPanel.opts;
        this.backends = new Map<IBackendConstructor<AbstractBackend>, AbstractBackend>();
        this.initApi(this, pluginContainerPanel.context, backends);
    }

    private async initApi(
        plugin: Plugin,
        context: cloudide.ExtensionContext,
        backendClasses: IBackendConstructor<AbstractBackend>[]
    ): Promise<void> {
        backendClasses.push(DefaultPluginApiHost);
        backendClasses.forEach((backendClass) => {
            if (!this.backends.get(backendClass)) {
                const backendInstance = new backendClass(plugin, context);
                this.backends.set(backendClass, backendInstance);
            }
        });
        const initPromises = [];
        const iterator = this.backends.values();
        let backendInstance: IteratorResult<AbstractBackend>;
        while (((backendInstance = iterator.next()), !backendInstance.done)) {
            initPromises.push(backendInstance.value.init());
        }
        await Promise.all(initPromises);
        await plugin.ready();
        this.backends.forEach((backendInstance) => {
            backendInstance.run();
        });
    }

    public static createOrShow(
        context: cloudide.ExtensionContext,
        opts: WebviewOptions,
        backends: IBackendConstructor<AbstractBackend>[]
    ): Plugin {
        if (Plugin.instance && !Plugin.instance.container.isDisposed()) {
            Plugin.instance.container.defaultPluginPanel.reveal(
                opts.targetArea,
                Plugin.instance.container.defaultPluginPanel.viewColumn,
                opts.preserveFocus
            );
            return Plugin.instance;
        }
        this.instance = new Plugin(new PluginContainerPanel(context, opts), backends);
        return Plugin.instance;
    }

    public static getInstance(): Plugin {
        return Plugin.instance;
    }

    public async ready(): Promise<boolean> {
        await this.pageInitialized.promise;
        this.call('cloudide.page.onBackendInitialized', true).then((result) => {
            if (result) {
                this.isReady.resolve(true);
            } else {
                this.isReady.resolve(false);
            }
        });
        return this.isReady.promise;
    }

    public async call(identifier: string, ...args: any[]): Promise<any> {
        await this.pageInitialized.promise;
        const messagingInstance = Messaging.getInstance();
        if (messagingInstance) {
            return messagingInstance.call(
                identifier.indexOf('::') >= 0 ? identifier : `${this.options.viewType}::${identifier}`,
                ...args
            );
        }
        return Promise.resolve(false);
    }

    public log(level: string, message: string): void {
        (this.backends.get(DefaultPluginApiHost) as DefaultPluginApiHost).log(level, message);
    }

    revive(panel: cloudide.WebviewPanel, context: cloudide.ExtensionContext, opts: WebviewOptions, state: any): void {
        if (this.container && this.container.isDisposed()) {
            if (typeof panel.showOptions === 'object') {
                panel.reveal(panel.showOptions.area, panel.viewColumn, opts.preserveFocus);
            } else {
                panel.reveal(panel.viewColumn, opts.preserveFocus);
            }
        } else {
            // dispose webview if already revealed in case plugin is registered to start on event "*"
            panel.dispose();
        }
    }

    dispose(): void {
        this.container.dispose();
    }

    get container(): PluginContainerPanel {
        return this._container;
    }

    get options(): WebviewOptions {
        return this._options;
    }

    public stop(): void {
        this.backends.forEach((backendInstance) => {
            backendInstance.stop();
        });
        this.dispose();
        this.container.context.subscriptions.forEach((disposable) => {
            disposable.dispose();
        });
    }
}

const backendClientIdentifier = 'backend';

/**
 * Plugin Container Panel to host html loaded from plugin
 */
@messaging(backendClientIdentifier)
class PluginContainerPanel implements IframeLike {
    readonly context: cloudide.ExtensionContext;
    readonly defaultPluginPanel: cloudide.WebviewPanel;
    private dispossed = false;
    private options: WebviewOptions;
    private messageHandler?: (message: any) => void;
    private disposedEventHandler?: (...args: any[]) => void;
    private revealingDynamicWebview: cloudide.WebviewPanel[] = [];

    constructor(context: cloudide.ExtensionContext, opts: WebviewOptions) {
        this.context = context;
        this.options = opts;
        // create default plugin page webview panel
        this.defaultPluginPanel = this.createWebviewPanel(this.options);
        this.update(this.options.viewType, this.options.viewUrl);
        this.defaultPluginPanel.onDidDispose(() => this.dispose());
        this.defaultPluginPanel.webview.onDidReceiveMessage((message) => {
            this.handleMessage(message);
        });
    }

    private handleMessage(message: any) {
        // Only handle the message from the hosted page
        if (!message.from || !message.func) {
            return;
        }
        // may cause performance problem
        this.postMessage(message);

        if (this.messageHandler) {
            this.messageHandler(message);
        }
    }

    private update(viewType: string, webviewUrl: string) {
        this.defaultPluginPanel.webview.html = this.renderHtml(viewType, webviewUrl);
    }

    public createWebviewPanel(opts: WebviewOptions): cloudide.WebviewPanel {
        this.options = opts;
        const panel = cloudide.window.createCloudWebviewPanel(
            opts.viewType,
            opts.title,
            {
                area: opts.targetArea,
                preserveFocus: opts.preserveFocus ? opts.preserveFocus : false
            },
            {
                enableScripts: true,
                localResourceRoots: [cloudide.Uri.file(path.join(this.context.extensionPath, 'resources'))],
                retainContextWhenHidden: true
            }
        );
        const lightIconUri = cloudide.Uri.file(
            path.join(
                this.context.extensionPath,
                typeof opts.iconPath === 'object' ? opts.iconPath.light : opts.iconPath
            )
        );
        const darkIconUri = cloudide.Uri.file(
            path.join(
                this.context.extensionPath,
                typeof opts.iconPath === 'object' ? opts.iconPath.dark : opts.iconPath
            )
        );
        panel.iconPath = { light: lightIconUri, dark: darkIconUri };
        return panel;
    }

    public isDynamicWebviewPanelRevealing(panel: cloudide.WebviewPanel): boolean {
        return !!this.revealingDynamicWebview.find((panel) => panel.viewType === panel.viewType);
    }

    public createDynamicWebviewPanel(opts: WebviewOptions, override?: boolean) {
        // return webview if already revealed
        let dynamicWebviewPanel = this.revealingDynamicWebview.find((panel) => panel.viewType === opts.viewType);
        if (dynamicWebviewPanel) {
            if (override) {
                dynamicWebviewPanel.title = opts.title;
                dynamicWebviewPanel.iconPath = opts.iconPath as any;
                dynamicWebviewPanel.webview.html = this.renderHtml(opts.viewType, opts.viewUrl, opts.extData);
            }
            if (!opts.preserveFocus) {
                dynamicWebviewPanel.reveal();
            }

            return dynamicWebviewPanel;
        }

        dynamicWebviewPanel = this.createWebviewPanel(opts);
        dynamicWebviewPanel.webview.html = this.renderHtml(opts.viewType, opts.viewUrl, opts.extData);
        dynamicWebviewPanel.onDidDispose(() => {
            this.revealingDynamicWebview = this.revealingDynamicWebview.filter((panel) => {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                return !panel.dispose && panel.viewType !== dynamicWebviewPanel!.viewType;
            });
        });
        dynamicWebviewPanel.webview.onDidReceiveMessage((message) => {
            this.handleMessage(message);
        });
        this.revealingDynamicWebview.push(dynamicWebviewPanel);
    }

    public disposeDynamicWebviewPanel(viewType: string) {
        const dynamicWebviewPanel = this.revealingDynamicWebview.find((panel) => panel.viewType === viewType);
        if (dynamicWebviewPanel) {
            dynamicWebviewPanel.dispose();
        }
    }

    registerMessageHandler(messageHandler: (message: any) => void): void {
        this.messageHandler = messageHandler;
    }

    postMessage(message: any) {
        this.defaultPluginPanel.webview.postMessage(message);
        this.revealingDynamicWebview.forEach((panel) => {
            panel.webview.postMessage(message);
        });
    }

    get opts() {
        return this.options;
    }

    public dispose() {
        this.dispossed = true;
        this.defaultPluginPanel.dispose();

        this.revealingDynamicWebview.forEach((webview) => {
            webview.dispose();
        });

        // fire event
        if (this.disposedEventHandler) {
            this.disposedEventHandler();
        }
    }

    onDispose(disposedEventHandler: (...args: any[]) => void) {
        this.disposedEventHandler = disposedEventHandler;
    }

    public isDisposed() {
        return this.dispossed;
    }

    public renderHtml(viewType: string, webviewUrl: string, extData?: any) {
        if (!this.defaultPluginPanel || !this.options || !this.context.extensionPath) {
            return '';
        }
        const extensionPath = this.context.extensionPath;
        let iframeHtmlUri = cloudide.Uri.file(path.join(extensionPath, 'resources/page', 'index.html'))
            .with({ scheme: 'theia-resource' })
            .toString();
        if (webviewUrl.startsWith('local:')) {
            const localEntryPoint = webviewUrl.replace('local:', '');
            const pathPrefix = localEntryPoint.substring(0, localEntryPoint.lastIndexOf('/'));
            const localEntryPath = path.join(extensionPath, localEntryPoint);
            const data = fs.readFileSync(localEntryPath, 'utf8');
            const $ = cheerio.load(data);
            $('head').prepend(`<script>
                const acquireCloudidePluginApi = (function() {
                    let acquired = false;
                    let extData = ${extData ? `JSON.parse(${JSON.stringify(JSON.stringify(extData))})` : undefined};
                    return () => {
                        if (acquired) {
						    throw new Error('An instance of the CloudIDE Plugin API has already been acquired');
                        }
                        acquired = true;
                        return Object.freeze({
                            getViewType: function() {
                                return '${viewType}';
                            },
                            getExtData: function() {
                                return extData;
                            }
                        });
                    };
                })();
            </script>`);
            $('[href], [src]').each((index, HtmlElement) => {
                const originSrc = $(HtmlElement).attr('src');
                const originHref = $(HtmlElement).attr('href');
                if (originSrc && !originSrc.startsWith('http')) {
                    $(HtmlElement).attr(
                        'src',
                        cloudide.Uri.file(path.join(extensionPath, `${pathPrefix}/${originSrc}`))
                            .with({ scheme: 'theia-resource' })
                            .toString()
                    );
                } else if (originHref && !originHref.startsWith('http')) {
                    $(HtmlElement).attr(
                        'href',
                        cloudide.Uri.file(path.join(extensionPath, `${pathPrefix}/${originHref}`))
                            .with({ scheme: 'theia-resource' })
                            .toString()
                    );
                }
            });

            return $.html();
        } else {
            webviewUrl = new URL(this.options.viewUrl).origin;
            iframeHtmlUri = this.options.viewUrl;
        }
        const nonce = uuid();

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">

                <!--
                Use a content security policy to only allow loading images from https or from our extension directory,
                scripts that have a specific nonce and only allow unsafe-inline for theme styles.

                <meta http-equiv="Content-Security-Policy" content="default-src 'self'  http://schemastore.azurewebsites.net ${webviewUrl}; style-src 'unsafe-inline';
                img-src theia-resource: https: http: data:; script-src 'nonce-${nonce}' 'self';"> -->

                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Huawei cloudide plugin</title>
                <style>
                    iframe {
                        flex-grow: 1;
                        border: none;
                        margin: 0;
                        padding: 0;
                        display: block;
                        overflow: hidden;
                        position: absolute;
                        width: 100%;
                        height: 100%;
                        visibility: visible;
                        background-color: var(--theia-layout-color1);
                    }
                </style>
            </head>
            <body style="background: var(--theia-layout-color1);margin: 0;">
                <iframe src="${iframeHtmlUri}" style="width: 100%; height: 100%;"></iframe>
            </body>
            </html>`;
    }
}

/**
 * default plugin backend api exposed to frontend page
 */
@exposable
export class DefaultPluginApiHost extends AbstractBackend {
    readonly subscribedEvents: string[] = [];
    readonly supportedEventTypes: Map<string, cloudide.Event<any>> = new Map()
        // events from workspace module
        .set('cloudide.workspace.onDidChangeConfiguration', cloudide.workspace.onDidChangeConfiguration)
        .set('cloudide.workspace.onDidChangeTextDocument', cloudide.workspace.onDidChangeTextDocument)
        .set('cloudide.workspace.onDidChangeWorkspaceFolders', cloudide.workspace.onDidChangeWorkspaceFolders)
        .set('cloudide.workspace.onDidCloseTextDocument', cloudide.workspace.onDidCloseTextDocument)
        .set('cloudide.workspace.onDidCreateFiles', cloudide.workspace.onDidCreateFiles)
        .set('cloudide.workspace.onDidDeleteFiles', cloudide.workspace.onDidDeleteFiles)
        .set('cloudide.workspace.onDidOpenTextDocument', cloudide.workspace.onDidOpenTextDocument)
        .set('cloudide.workspace.onDidRenameFiles', cloudide.workspace.onDidRenameFiles)
        .set('cloudide.workspace.onDidSaveTextDocument', cloudide.workspace.onDidSaveTextDocument)
        .set('cloudide.workspace.onWillCreateFiles', cloudide.workspace.onWillCreateFiles)
        .set('cloudide.workspace.onWillDeleteFiles', cloudide.workspace.onWillDeleteFiles)
        .set('cloudide.workspace.onWillRenameFiles', cloudide.workspace.onWillRenameFiles)
        .set('cloudide.workspace.onWillSaveTextDocument', cloudide.workspace.onWillSaveTextDocument)
        // events from debug module
        .set('cloudide.debug.onDidChangeActiveDebugSession', cloudide.debug.onDidChangeActiveDebugSession)
        .set('cloudide.debug.onDidChangeBreakpoints', cloudide.debug.onDidChangeBreakpoints)
        .set('cloudide.debug.onDidReceiveDebugSessionCustomEvent', cloudide.debug.onDidReceiveDebugSessionCustomEvent)
        .set('cloudide.debug.onDidStartDebugSession', cloudide.debug.onDidStartDebugSession)
        .set('cloudide.debug.onDidTerminateDebugSession', cloudide.debug.onDidTerminateDebugSession)
        // events from languages module
        .set('cloudide.languages.onDidChangeDiagnostics', cloudide.languages.onDidChangeDiagnostics)
        // events from plugins module
        .set('cloudide.plugins.onDidChange', cloudide.extensions.onDidChange)
        // events from tasks module
        .set('cloudide.tasks.onDidEndTask', cloudide.tasks.onDidEndTask)
        .set('cloudide.tasks.onDidEndTaskProcess', cloudide.tasks.onDidEndTaskProcess)
        .set('cloudide.tasks.onDidStartTask', cloudide.tasks.onDidStartTask)
        .set('cloudide.tasks.onDidStartTaskProcess', cloudide.tasks.onDidStartTaskProcess)
        // events from window module
        .set('cloudide.window.onDidChangeActiveTerminal', cloudide.window.onDidChangeActiveTerminal)
        .set('cloudide.window.onDidChangeActiveTextEditor', cloudide.window.onDidChangeActiveTextEditor)
        .set('cloudide.window.onDidChangeTextEditorOptions', cloudide.window.onDidChangeTextEditorOptions)
        .set('cloudide.window.onDidChangeTextEditorSelection', cloudide.window.onDidChangeTextEditorSelection)
        .set('cloudide.window.onDidChangeTextEditorViewColumn', cloudide.window.onDidChangeTextEditorViewColumn)
        .set('cloudide.window.onDidChangeTextEditorVisibleRanges', cloudide.window.onDidChangeTextEditorVisibleRanges)
        .set('cloudide.window.onDidChangeVisibleTextEditors', cloudide.window.onDidChangeVisibleTextEditors)
        .set('cloudide.window.onDidChangeWindowState', cloudide.window.onDidChangeWindowState)
        .set('cloudide.window.onDidCloseTerminal', cloudide.window.onDidCloseTerminal)
        .set('cloudide.window.onDidOpenTerminal', cloudide.window.onDidOpenTerminal);

    private huaweiCommonApi?: any;

    public async init(): Promise<void> {
        // do nothing
    }

    public run(): void {
        this.registerEventListener();
    }

    public stop(): void {
        this.subscribedEvents.length = 0;
    }

    private registerEventListener() {
        this.supportedEventTypes.forEach((onEvent, eventType) => {
            this.context.subscriptions.push(
                onEvent((event) => {
                    if (this.subscribedEvents.indexOf(eventType) >= 0) {
                        this.fireTheiaEvent(eventType, event);
                    }
                })
            );
        });
    }

    // get plugin package.json
    @expose('cloudide.plugin')
    public getPackageJson(): any {
        return packageJson;
    }

    @expose('cloudide.plugin.onPageInit')
    public onPageInit(success?: boolean): boolean {
        if (!Plugin.getInstance().pageInitialized.isPending) {
            Plugin.getInstance()
                .call('cloudide.page.onBackendInitialized', true)
                .then((result) => {
                    if (result) {
                        console.log('backend already initialized, renotify plugin frontend success.');
                    }
                });
        }

        const huaweiCommon = cloudide.extensions.getExtension('huawei-builtin.huawei-cloudide-common');
        this.huaweiCommonApi = huaweiCommon ? huaweiCommon.exports : this.huaweiCommonApi;

        Plugin.getInstance().pageInitialized.resolve(!!success);

        this.subscribeEvent(beforeUninstallEventType);

        return !!success;
    }

    @expose('cloudide.plugin.createDynamicWebview')
    public createDynamicWebview(opts: WebviewOptions, override?: boolean): void {
        Plugin.getInstance().container.createDynamicWebviewPanel(opts, override);
    }

    @expose('cloudide.plugin.disposeDynamicWebview')
    public disposeDynamicWebview(viewType: string): void {
        Plugin.getInstance().container.disposeDynamicWebviewPanel(viewType);
    }

    @expose('cloudide.api')
    public getTheiaApi(...property: string[]): any {
        const properties = {};
        if (!property || property.length === 0) {
            Object.keys(cloudide).forEach((key) => {
                const value = String((cloudide as any)[key]);
                (properties as any)[key] = {
                    value: value,
                    type: typeof (cloudide as any)[key]
                };
            });
            return properties;
        }
        let currentPro: any;
        property.forEach((pro) => {
            currentPro = (cloudide as any)[pro] ? (cloudide as any)[pro] : undefined;
        });
        if (!currentPro) {
            return undefined;
        }
        const currentProChildren = Object.keys(currentPro);
        if (!currentProChildren) {
            return undefined;
        }
        currentProChildren.forEach((key) => {
            const value = currentPro[key];
            if (typeof value === 'object' || typeof value !== 'function') {
                (properties as any)[key] = {
                    value: String(value),
                    type: typeof value
                };
            } else if (typeof value === 'function') {
                (properties as any)[key] = {
                    value: value.toString(),
                    type: typeof value
                };
            }
        });
        return properties;
    }

    @expose('cloudide.plugin.getSupportedEventTypes')
    public getSupportedEventTypes(): any {
        const retEventTypes = {};
        this.supportedEventTypes.forEach((value, key) => {
            (retEventTypes as any)[key] = value.toString();
        });
        return retEventTypes;
    }

    @expose('cloudide.plugin.subscribeEvent')
    public subscribeEvent(eventType: string): void {
        if (this.supportedEventTypes.get(eventType) && this.subscribedEvents.indexOf(eventType) < 0) {
            this.subscribedEvents.push(eventType);
        } else {
            if (this.huaweiCommonApi) {
                this.huaweiCommonApi.onEvent(eventType, (eventType: string, event: any) => {
                    this.fireTheiaEvent(eventType, event);
                });
            }
        }
    }

    @expose('cloudide.plugin.unsubscribeEvent')
    public unsubscribeEvent(eventType: string): void {
        this.subscribedEvents.splice(this.subscribedEvents.indexOf(eventType), 1);
    }

    @expose('cloudide.plugin.fireEvent')
    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    public fireEventToPlugins(eventType: string, event: any): void {
        if (this.huaweiCommonApi) {
            this.huaweiCommonApi.fireEvent(eventType, event);
        }
    }

    @expose('cloudide.plugin.getExtensionPath')
    public getExtensionPath(): string {
        return Plugin.getInstance().container.context.extensionPath;
    }

    @expose('cloudide')
    public theiaWindowApi(module: string, property: string, ...args: any[]): any {
        if (!module || !property) {
            return Promise.reject('module or property not specified.');
        }
        const theiaModule = (cloudide as any)[module];
        const theiaModuleProp = theiaModule[property];
        if (typeof theiaModuleProp === 'function') {
            return Promise.resolve(theiaModuleProp.apply(theiaModuleProp, args));
        } else {
            return Promise.resolve(theiaModuleProp);
        }
    }

    @expose('cloudide.log')
    public log(level: string, message: string): void {
        const currentTime = new Date().toISOString().replace('T', ' ').substr(0, 19);
        console.log(`[${level}][${currentTime}][plugin][${Plugin.getInstance().options.viewType}] ${message}`);
    }

    @call('cloudide.page.onEvent')
    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    public fireTheiaEvent(type: string, event: any): void {
        // console.log(`firevent: ${type}`);
        if (
            type === beforeUninstallEventType &&
            event &&
            (event.pluginId as string).toLowerCase() === `${packageJson.publisher}.${packageJson.name}`.toLowerCase()
        ) {
            Plugin.getInstance().stop();
        }
    }
}
