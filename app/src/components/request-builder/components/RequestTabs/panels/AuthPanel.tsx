/**
 * AuthPanel Component
 * 
 * Authentication configuration:
 * - None
 * - Bearer Token
 * - Basic Auth
 * - API Key
 * - OAuth 2.0 (TODO)
 */

import { Key, Lock, User, KeyRound } from "lucide-react";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Badge,
    Label,
} from "@/components/ui";
import { useRequestBuilderContext } from "../../../context";
import VariableInput from "../../../shared/VariableInput";
import type { AuthType } from "../../../types";

const AUTH_TYPES: { value: AuthType; label: string; icon: typeof Key }[] = [
    { value: "none", label: "No Auth", icon: Lock },
    { value: "bearer", label: "Bearer Token", icon: Key },
    { value: "basic", label: "Basic Auth", icon: User },
    { value: "api-key", label: "API Key", icon: KeyRound },
];

export default function AuthPanel() {
    const { request, updateField, setRequest } = useRequestBuilderContext();
    const authType = request.authType;
    const authConfig = request.authConfig;

    const handleTypeChange = (type: AuthType) => {
        // Initialize defaults for each type
        let newConfig: Record<string, any> = {};

        if (type === "bearer") {
            newConfig = { token: authConfig.token || "" };
        } else if (type === "basic") {
            newConfig = { username: authConfig.username || "", password: authConfig.password || "" };
        } else if (type === "api-key") {
            newConfig = {
                key: authConfig.key || "",
                value: authConfig.value || "",
                addTo: authConfig.addTo || "header"
            };
        }

        setRequest({ authType: type, authConfig: newConfig });
    };

    const updateConfig = (updates: Record<string, any>) => {
        updateField("authConfig", { ...authConfig, ...updates });
    };

    return (
        <div className="space-y-6">
            {/* Auth Type Selector */}
            <div className="space-y-2">
                <Label>Authentication Type</Label>
                <Select value={authType} onValueChange={handleTypeChange}>
                    <SelectTrigger className="w-48">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {AUTH_TYPES.map((type) => {
                            const Icon = type.icon;
                            return (
                                <SelectItem key={type.value} value={type.value}>
                                    <div className="flex items-center gap-2">
                                        <Icon className="w-4 h-4" />
                                        <span>{type.label}</span>
                                    </div>
                                </SelectItem>
                            );
                        })}
                    </SelectContent>
                </Select>
            </div>

            {/* Auth Configuration */}
            {authType === "none" && (
                <div className="py-8 text-center text-muted-foreground">
                    <Lock className="w-8 h-8 mx-auto mb-2 opacity-50" />
                    <p>No authentication will be sent with this request.</p>
                </div>
            )}

            {authType === "bearer" && (
                <div className="space-y-4">
                    <p className="text-sm text-muted-foreground">
                        The token will be sent as <code className="bg-muted px-1 rounded">Authorization: Bearer &lt;token&gt;</code>
                    </p>
                    <div className="space-y-2">
                        <Label>Token</Label>
                        <VariableInput
                            value={authConfig.token || ""}
                            onChange={(token) => updateConfig({ token })}
                            placeholder="Enter bearer token or {{variable}}"
                        />
                    </div>
                </div>
            )}

            {authType === "basic" && (
                <div className="space-y-4">
                    <p className="text-sm text-muted-foreground">
                        Credentials will be sent as <code className="bg-muted px-1 rounded">Authorization: Basic &lt;base64&gt;</code>
                    </p>
                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label>Username</Label>
                            <VariableInput
                                value={authConfig.username || ""}
                                onChange={(username) => updateConfig({ username })}
                                placeholder="Username"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label>Password</Label>
                            <VariableInput
                                value={authConfig.password || ""}
                                onChange={(password) => updateConfig({ password })}
                                placeholder="Password"
                            />
                        </div>
                    </div>
                </div>
            )}

            {authType === "api-key" && (
                <div className="space-y-4">
                    <p className="text-sm text-muted-foreground">
                        The API key will be added as a {authConfig.addTo === "header" ? "header" : "query parameter"}.
                    </p>

                    <div className="space-y-2">
                        <Label>Add to</Label>
                        <Select
                            value={authConfig.addTo || "header"}
                            onValueChange={(addTo: "header" | "query") => updateConfig({ addTo })}
                        >
                            <SelectTrigger className="w-48">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="header">Header</SelectItem>
                                <SelectItem value="query">Query Params</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label>Key</Label>
                            <VariableInput
                                value={authConfig.key || ""}
                                onChange={(key) => updateConfig({ key })}
                                placeholder="X-API-Key"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label>Value</Label>
                            <VariableInput
                                value={authConfig.value || ""}
                                onChange={(value) => updateConfig({ value })}
                                placeholder="{{api_key}}"
                            />
                        </div>
                    </div>
                </div>
            )}

            {/* OAuth 2.0 TODO */}
            <div className="pt-4 border-t border-border">
                <Badge variant="outline" className="text-xs">
                    OAuth 2.0 - Coming Soon
                </Badge>
            </div>
        </div>
    );
}
