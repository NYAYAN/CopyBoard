// Global hotkeys for physical keys Electron's accelerator strings cannot name.
//
// Electron's globalShortcut takes an accelerator STRING and resolves it through
// Chromium's key tables. Those tables have no token for a few physical keys — most
// visibly kVK_ISO_Section, the key below Esc on Apple's ISO keyboards, which prints
// " on Turkish-Q. Registering "CommandOrControl+\"" instead binds the US quote
// position (the i/İ key there), so the shortcut silently answers the wrong key.
//
// Carbon's RegisterEventHotKey takes a raw virtual keycode, so it has no such gap.
// This is the same OS mechanism Electron itself uses on macOS — it is not a key
// monitor: nothing runs until the exact combination is pressed, so it costs nothing
// while the user types. (An event tap, which every "global key listener" package
// uses, would see every keystroke on the system. Deliberately not that.)
//
// TWO RULES IN HERE, both learned from crashes:
//
// 1. Our hot keys are registered on the EVENT DISPATCHER target, not the application
//    target. Chromium's own globalShortcut handler sits on the application target and
//    asserts that every hot key event it receives belongs to its map — so an event of
//    ours reaching it takes the whole process down with SIGTRAP (verified: it is
//    Electron's frame that traps, not ours, and it only happens when both are live).
//    Delivering ours to the dispatcher target keeps the two mechanisms apart, so
//    Electron's accelerators and these raw-keycode ones can coexist.
//
// 2. The Carbon handler must not touch V8. A hot key can arrive while the main thread
//    is inside a nested run loop (menu tracking, a window drag) where reentering JS is
//    not safe. The handler only pushes the id through a thread-safe function and
//    returns; the JS callback runs later, from the normal event loop.

#include <napi.h>
#include <Carbon/Carbon.h>
#include <map>

namespace {

const OSType kSignature = 'cpbd'; // CopyBoard — namespaces our hot key ids

std::map<uint32_t, EventHotKeyRef> g_bindings;
EventHandlerRef g_handler = nullptr;
EventHandlerUPP g_handlerUPP = nullptr;
Napi::ThreadSafeFunction g_tsfn;
bool g_started = false;

// Returning noErr means "handled, stop propagating". This handler sits on the event
// dispatcher target, so EVERY hot key in the process passes through it first —
// including Electron's. Anything that isn't ours must therefore leave with
// eventNotHandledErr, or the accelerators registered through globalShortcut are
// silently swallowed and simply stop firing.
OSStatus HotKeyHandler(EventHandlerCallRef, EventRef event, void*) {
    const bool debug = getenv("MAC_HOTKEY_DEBUG") != nullptr;
    EventHotKeyID pressed;
    if (GetEventParameter(event, kEventParamDirectObject, typeEventHotKeyID, nullptr,
                          sizeof(pressed), nullptr, &pressed) != noErr) {
        return eventNotHandledErr;
    }
    if (!g_started || pressed.signature != kSignature) {
        if (debug) fprintf(stderr, "[mac-hotkey] passing through foreign hot key\n");
        return eventNotHandledErr; // Electron's — let it through
    }
    if (debug) fprintf(stderr, "[mac-hotkey] handling our hot key id=%u\n", pressed.id);

    const uint32_t id = pressed.id;
    // Queue only — see the note above about not entering V8 from here.
    g_tsfn.NonBlockingCall([id](Napi::Env env, Napi::Function callback) {
        callback.Call({Napi::Number::New(env, id)});
    });
    return noErr;
}

// start(callback) -> bool. Installs the one application-wide handler.
Napi::Value Start(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (g_started) return Napi::Boolean::New(env, true);

    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::TypeError::New(env, "start(callback) requires a function").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    g_tsfn = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(), "mac_hotkey", 0, 1);
    // Don't hold the event loop open — the app must still be able to quit.
    g_tsfn.Unref(env);

    EventTypeSpec spec = {kEventClassKeyboard, kEventHotKeyPressed};
    g_handlerUPP = NewEventHandlerUPP(HotKeyHandler);
    OSStatus status = InstallEventHandler(GetEventDispatcherTarget(), g_handlerUPP,
                                          1, &spec, nullptr, &g_handler);
    if (status != noErr) {
        DisposeEventHandlerUPP(g_handlerUPP);
        g_handlerUPP = nullptr;
        g_tsfn.Release();
        return Napi::Boolean::New(env, false);
    }

    g_started = true;
    return Napi::Boolean::New(env, true);
}

// registerHotKey(id, keyCode, cmd, shift, alt, ctrl) -> bool
Napi::Value RegisterHotKey(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!g_started) return Napi::Boolean::New(env, false);
    if (info.Length() < 6) {
        Napi::TypeError::New(env, "registerHotKey(id, keyCode, cmd, shift, alt, ctrl)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    const uint32_t id = info[0].As<Napi::Number>().Uint32Value();
    const uint32_t keyCode = info[1].As<Napi::Number>().Uint32Value();
    UInt32 mods = 0;
    if (info[2].ToBoolean().Value()) mods |= cmdKey;
    if (info[3].ToBoolean().Value()) mods |= shiftKey;
    if (info[4].ToBoolean().Value()) mods |= optionKey;
    if (info[5].ToBoolean().Value()) mods |= controlKey;

    if (g_bindings.count(id)) return Napi::Boolean::New(env, false); // id already live

    EventHotKeyID hotKeyId = {kSignature, id};
    EventHotKeyRef ref = nullptr;
    // Dispatcher target — see rule 1 at the top of this file.
    OSStatus status = RegisterEventHotKey(keyCode, mods, hotKeyId,
                                          GetEventDispatcherTarget(), 0, &ref);
    if (status != noErr || ref == nullptr) return Napi::Boolean::New(env, false);

    g_bindings[id] = ref;
    return Napi::Boolean::New(env, true);
}

// unregisterHotKey(id) -> bool
Napi::Value UnregisterHotKey(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1) return Napi::Boolean::New(env, false);

    const uint32_t id = info[0].As<Napi::Number>().Uint32Value();
    auto it = g_bindings.find(id);
    if (it == g_bindings.end()) return Napi::Boolean::New(env, false);

    UnregisterEventHotKey(it->second);
    g_bindings.erase(it);
    return Napi::Boolean::New(env, true);
}

Napi::Value UnregisterAll(const Napi::CallbackInfo& info) {
    for (auto& entry : g_bindings) UnregisterEventHotKey(entry.second);
    g_bindings.clear();
    return Napi::Boolean::New(info.Env(), true);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("start", Napi::Function::New(env, Start));
    exports.Set("registerHotKey", Napi::Function::New(env, RegisterHotKey));
    exports.Set("unregisterHotKey", Napi::Function::New(env, UnregisterHotKey));
    exports.Set("unregisterAll", Napi::Function::New(env, UnregisterAll));
    return exports;
}

} // namespace

NODE_API_MODULE(mac_hotkey, Init)
