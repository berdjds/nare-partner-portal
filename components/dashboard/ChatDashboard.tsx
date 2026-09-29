"use client";

import { useEffect, useRef, useState } from "react";
import axios from "axios";
import { Send, Paperclip, Phone, RefreshCw, LogOut, MessageSquarePlus, ArrowLeft, Calculator, Plane } from "lucide-react";
import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSocket } from "@/hooks/useSocket";
import { useToast } from "@/components/ui/toast";

interface Chat {
  id: string;
  remoteJid: string;
  name: string;
  phone: string | null;
  profilePicUrl: string | null;
  lastMessageAt: string;
  messages: {
    body: string;
    timestamp: string;
    fromMe: boolean;
    type: string;
  }[];
}

interface Message {
  id: string;
  chatId: string;
  remoteJid: string;
  fromMe: boolean;
  body: string;
  type: string;
  mediaUrl: string | null;
  mediaMimeType: string | null;
  mediaCaption: string | null;
  timestamp: string;
}

export default function ChatDashboard({ isAdmin }: { isAdmin: boolean }) {
  const { connected, unauthorized, whatsAppState, lastEvent, disconnectSocket } = useSocket();
  const [chats, setChats] = useState<Chat[]>([]);
  const [selectedChat, setSelectedChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [newNumber, setNewNumber] = useState("");
  const [newMessage, setNewMessage] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  // Prefer the phone number (we trust it — either it is the jid user part or
  // a number we dialed ourselves), then the contact name. Opaque @lid jids are
  // never shown raw in the UI.
  function chatDisplayName(chat: Chat) {
    if (chat.phone) return `+${chat.phone}`;
    if (chat.name) return chat.name;
    if (chat.remoteJid.endsWith("@c.us")) return `+${chat.remoteJid.split("@")[0]}`;
    return "Unknown contact";
  }

  // Secondary line under the header title: when the number leads, show the
  // contact name (if any); for @lid chats note that WhatsApp hides the number.
  function chatSubtitle(chat: Chat) {
    if (chat.phone || chat.remoteJid.endsWith("@c.us")) return chat.name || "";
    return "Number hidden by WhatsApp";
  }

  async function fetchChats() {
    try {
      const res = await axios.get("/api/chats");
      setChats(res.data);
    } catch {
      toast("Failed to load chats", "error");
    }
  }

  // Interim W1 policy: admins read the raw connection state from their full
  // whatsapp_state payload; other inbox users receive only { connected }.
  const waAvailable = isAdmin ? whatsAppState?.state === "ready" : whatsAppState?.connected === true;

  async function handleStartNewChat(e?: React.FormEvent) {
    e?.preventDefault();
    if (!newNumber.trim() || !newMessage.trim()) return;
    const cleaned = newNumber.replace(/\D/g, "");
    if (!cleaned) return;
    const remoteJid = newNumber.includes("@") ? newNumber : `${cleaned}@c.us`;

    setLoading(true);
    try {
      await axios.post("/api/send", { remoteJid, body: newMessage, type: "text" });
      toast("Message sent", "success");
      setNewChatOpen(false);
      setNewNumber("");
      setNewMessage("");
      fetchChats();
    } catch (err: any) {
      toast(err?.response?.data?.error || "Failed to send message", "error");
    } finally {
      setLoading(false);
    }
  }

  async function fetchMessages(chat: Chat) {
    try {
      const res = await axios.get(`/api/messages?chatId=${chat.id}`);
      setMessages(res.data);
    } catch {
      toast("Failed to load messages", "error");
    }
  }

  useEffect(() => {
    fetchChats();
  }, []);

  useEffect(() => {
    if (selectedChat) {
      fetchMessages(selectedChat);
    }
  }, [selectedChat?.id]);

  useEffect(() => {
    if (lastEvent?.type === "message") {
      const msg = lastEvent.payload as Message;
      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
      setChats((prev) => {
        const idx = prev.findIndex((c) => c.remoteJid === msg.remoteJid);
        if (idx === -1) return prev;
        const next = [...prev];
        next[idx] = { ...next[idx], lastMessageAt: msg.timestamp, messages: [{ body: msg.body || "", timestamp: msg.timestamp, fromMe: msg.fromMe, type: msg.type }] };
        return next.sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime());
      });
    }
    if (lastEvent?.type === "chat_update") {
      fetchChats();
    }
  }, [lastEvent]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend(e?: React.FormEvent) {
    e?.preventDefault();
    if (!selectedChat || (!input.trim() && !selectedFile)) return;

    setLoading(true);
    try {
      let type: "text" | "image" | "voice" | "document" = "text";
      let mediaBase64: string | undefined;
      let mediaMimeType: string | undefined;
      let mediaFilename: string | undefined;

      if (selectedFile) {
        mediaMimeType = selectedFile.type;
        mediaFilename = selectedFile.name;
        if (selectedFile.type.startsWith("image/")) type = "image";
        else if (selectedFile.type.startsWith("audio/")) type = "voice";
        else type = "document";
        const bytes = new Uint8Array(await selectedFile.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        mediaBase64 = btoa(binary);
      }

      await axios.post("/api/send", {
        remoteJid: selectedChat.remoteJid,
        body: input,
        type,
        mediaBase64,
        mediaMimeType,
        mediaFilename,
      });

      setInput("");
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err: any) {
      toast(err?.response?.data?.error || "Failed to send message", "error");
    } finally {
      setLoading(false);
    }
  }

  function renderMessage(msg: Message) {
    const isMedia = msg.type === "image" || msg.type === "voice" || msg.type === "document" || msg.type === "video";
    return (
      <div key={msg.id} className={`flex ${msg.fromMe ? "justify-end" : "justify-start"}`}>
        <div className={`max-w-[70%] rounded-2xl px-4 py-2 ${msg.fromMe ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
          {isMedia && msg.mediaUrl && (
            <div className="mb-2">
              {msg.type === "image" ? (
                <a href={msg.mediaUrl} target="_blank" rel="noreferrer">
                  <img src={msg.mediaUrl} alt="media" className="max-h-48 rounded-lg object-cover" />
                </a>
              ) : msg.type === "voice" ? (
                <audio controls src={msg.mediaUrl} className="w-full" />
              ) : (
                <a href={msg.mediaUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 underline">
                  <Paperclip className="h-4 w-4" /> {msg.mediaCaption || "File"}
                </a>
              )}
            </div>
          )}
          {msg.body && <p className="text-sm whitespace-pre-wrap">{msg.body}</p>}
          <span className="mt-1 block text-[10px] opacity-70">
            {new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen h-dvh flex-col bg-background">
      {/* Header */}
      <header className="flex items-center justify-between gap-2 border-b px-3 py-2 sm:px-4 sm:py-3">
        <div className="flex items-center gap-2 sm:gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-green-700 text-xs font-bold text-white shadow-sm">
            WA
          </div>
          <h1 className="hidden font-semibold min-[400px]:inline">WAControl</h1>
          {isAdmin && (
            <Button variant="outline" size="sm" onClick={() => (window.location.href = "/admin")}>
              Admin
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => (window.location.href = "/calculator")}>
            <Calculator className="h-4 w-4 sm:mr-1" />
            <span className="hidden sm:inline">Calculator</span>
          </Button>
          <Button variant="outline" size="sm" onClick={() => (window.location.href = "/travel")}>
            <Plane className="h-4 w-4 sm:mr-1" />
            <span className="hidden sm:inline">Travel</span>
          </Button>
          <Button variant="outline" size="sm" onClick={() => setNewChatOpen(true)}>
            <MessageSquarePlus className="h-4 w-4 sm:mr-1" />
            <span className="hidden sm:inline">New message</span>
          </Button>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <Badge className="hidden sm:inline-flex" variant={connected ? "default" : "destructive"}>
            {unauthorized ? "Session expired" : connected ? "Socket connected" : "Socket offline"}
          </Badge>
          {/* Interim W1 policy: non-admins see availability only as
              connected/not connected, never the raw connection state. */}
          <Badge variant={waAvailable ? "default" : "outline"}>
            {isAdmin
              ? whatsAppState?.state || "initializing"
              : waAvailable
                ? "Connected"
                : "Not connected"}
          </Badge>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              disconnectSocket();
              signOut({ callbackUrl: "/login" });
            }}
          >
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Chat list: full-width on mobile, sidebar on md+ */}
        <aside className={`${selectedChat ? "hidden" : "flex"} w-full flex-col border-r bg-card md:flex md:max-w-sm`}>
          <div className="border-b p-3">
            <Input placeholder="Search chats..." />
          </div>
          <div className="flex-1 overflow-y-auto">
            {chats.map((chat) => (
              <button
                key={chat.id}
                onClick={() => setSelectedChat(chat)}
                className={`flex w-full items-center gap-3 border-b px-4 py-3 text-left hover:bg-accent ${selectedChat?.id === chat.id ? "bg-accent" : ""}`}
              >
                <Avatar>
                  <AvatarImage src={chat.profilePicUrl || undefined} />
                  <AvatarFallback>{chatDisplayName(chat).slice(0, 2).toUpperCase()}</AvatarFallback>
                </Avatar>
                <div className="flex-1 overflow-hidden">
                  <div className="flex items-center justify-between">
                    <p className="truncate font-medium">{chatDisplayName(chat)}</p>
                    <span className="text-xs text-muted-foreground">{chat.lastMessageAt ? new Date(chat.lastMessageAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</span>
                  </div>
                  <p className="truncate text-sm text-muted-foreground">
                    {chat.messages[0]
                      ? `${chat.messages[0].fromMe ? "You: " : ""}${
                          chat.messages[0].type !== "text"
                            ? `[${chat.messages[0].type}]`
                            : chat.messages[0].body || ""
                        }`
                      : ""}
                  </p>
                </div>
              </button>
            ))}
            {chats.length === 0 && <p className="p-4 text-sm text-muted-foreground">No chats yet.</p>}
          </div>
          <div className="border-t px-3 py-2 text-center text-[11px] text-muted-foreground">
            Developed by <span className="font-medium text-foreground/70">Hayk FZC</span>
          </div>
        </aside>

        {/* Conversation: full-screen on mobile when a chat is selected */}
        <main className={`${selectedChat ? "flex" : "hidden"} flex-1 flex-col bg-background md:flex`}>
          {selectedChat ? (
            <>
              <div className="flex items-center justify-between border-b px-3 py-2 sm:px-4 sm:py-3">
                <div className="flex min-w-0 items-center gap-2 sm:gap-3">
                  <Button variant="ghost" size="icon" className="shrink-0 md:hidden" onClick={() => setSelectedChat(null)}>
                    <ArrowLeft className="h-4 w-4" />
                  </Button>
                  <Avatar>
                    <AvatarImage src={selectedChat.profilePicUrl || undefined} />
                    <AvatarFallback>{chatDisplayName(selectedChat).slice(0, 2).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="truncate font-medium">{chatDisplayName(selectedChat)}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {chatSubtitle(selectedChat)}
                    </p>
                  </div>
                </div>
                <Button variant="ghost" size="icon" className="shrink-0" onClick={() => fetchMessages(selectedChat)}>
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </div>

              <div className="flex-1 space-y-4 overflow-y-auto p-4">
                {messages.map(renderMessage)}
                <div ref={messagesEndRef} />
              </div>

              <form onSubmit={handleSend} className="border-t p-3">
                {selectedFile && (
                  <div className="mb-2 flex items-center gap-2 text-sm">
                    <Paperclip className="h-4 w-4" />
                    <span className="truncate">{selectedFile.name}</span>
                    <button type="button" className="text-destructive" onClick={() => { setSelectedFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}>
                      ×
                    </button>
                  </div>
                )}
                <div className="flex items-end gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    accept="image/*,audio/*,video/*,.pdf,.doc,.docx"
                    onChange={(e) => e.target.files && setSelectedFile(e.target.files[0])}
                  />
                  <Button type="button" variant="outline" size="icon" onClick={() => fileInputRef.current?.click()}>
                    <Paperclip className="h-4 w-4" />
                  </Button>
                  <Textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Type a message..."
                    className="min-h-0 flex-1 resize-none"
                    rows={1}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleSend();
                      }
                    }}
                  />
                  <Button type="submit" disabled={loading || (!input.trim() && !selectedFile)}>
                    <Send className="h-4 w-4" />
                  </Button>
                </div>
              </form>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center text-muted-foreground">
              <Phone className="mb-2 h-12 w-12 opacity-20" />
              <p>Select a chat to start messaging</p>
              {!waAvailable && (
                <p className="mt-2 text-sm">
                  {isAdmin
                    ? `WhatsApp state: ${whatsAppState?.state || "initializing"}`
                    : "WhatsApp not connected"}
                </p>
              )}
            </div>
          )}
        </main>
      </div>

      <Dialog open={newChatOpen} onOpenChange={setNewChatOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send message to new number</DialogTitle>
            <DialogDescription>Enter the phone number with country code and the message.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleStartNewChat} className="space-y-4">
            <div>
              <Label>Phone number</Label>
              <Input
                placeholder="37412345678"
                value={newNumber}
                onChange={(e) => setNewNumber(e.target.value)}
                required
              />
            </div>
            <div>
              <Label>Message</Label>
              <Textarea
                placeholder="Type a message..."
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                required
                rows={3}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setNewChatOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={loading || !newNumber.trim() || !newMessage.trim()}>
                Send
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
