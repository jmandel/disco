// Minimal hand-written types for the CDP shapes we touch (BRIEF §1.2). Extend as used; never import the full protocol.
export interface TargetInfo { targetId: string; type: string; title: string; url: string; attached: boolean; openerId?: string; canAccessOpener?: boolean; browserContextId?: string; subtype?: string }
export interface AttachedToTarget { sessionId: string; targetInfo: TargetInfo; waitingForDebugger: boolean }
export interface Initiator { type: "parser" | "script" | "preload" | "SignedExchange" | "preflight" | "other"; stack?: { callFrames: CallFrame[]; parent?: any }; url?: string; lineNumber?: number }
export interface CallFrame { functionName: string; scriptId: string; url: string; lineNumber: number; columnNumber: number }
export interface RequestWillBeSent {
  requestId: string; loaderId: string; documentURL: string;
  request: { url: string; method: string; headers: Record<string, string>; postData?: string; hasPostData?: boolean };
  timestamp: number; wallTime: number; initiator: Initiator; redirectResponse?: ResponseInfo; type?: string; frameId?: string; hasUserGesture?: boolean;
}
export interface ResponseInfo { url: string; status: number; statusText: string; headers: Record<string, string>; mimeType: string; encodedDataLength: number; fromDiskCache?: boolean; fromServiceWorker?: boolean; protocol?: string; timing?: any }
export interface ResponseReceived { requestId: string; loaderId: string; timestamp: number; type: string; response: ResponseInfo; frameId?: string }
export interface LoadingFinished { requestId: string; timestamp: number; encodedDataLength: number }
export interface LoadingFailed { requestId: string; timestamp: number; type: string; errorText: string; canceled?: boolean }
export interface WebSocketFrame { requestId: string; timestamp: number; response: { opcode: number; mask: boolean; payloadData: string } }
export interface ScreencastFrame { data: string; metadata: { offsetTop: number; pageScaleFactor: number; deviceWidth: number; deviceHeight: number; scrollOffsetX: number; scrollOffsetY: number; timestamp?: number }; sessionId: number }
export interface JavascriptDialogOpening { url: string; message: string; type: "alert" | "confirm" | "prompt" | "beforeunload"; hasBrowserHandler: boolean; defaultPrompt?: string }
export interface Frame { id: string; parentId?: string; loaderId: string; name?: string; url: string; securityOrigin?: string; mimeType?: string }
export interface ExecutionContextDescription { id: number; origin: string; name: string; uniqueId: string; auxData?: { isDefault?: boolean; type?: string; frameId?: string } }
export interface RemoteObject { type: string; subtype?: string; className?: string; value?: any; description?: string; objectId?: string }
export interface BoxModel { content: number[]; padding: number[]; border: number[]; margin: number[]; width: number; height: number }
