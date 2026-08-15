# macOS-only addon. On every other platform the target builds to nothing, so a
# stray `node-gyp rebuild` can't fail the install.
{
  "targets": [
    {
      "target_name": "mac_hotkey",
      "conditions": [
        ["OS!='mac'", { "type": "none" }],
        ["OS=='mac'", {
          "sources": ["src/mac_hotkey.mm"],
          # include_dir, not include: the quoted-list form splits the path on
          # whitespace, and this repo can sit under a directory that has a space.
          "include_dirs": ["<!(node -p \"require('node-addon-api').include_dir\")"],
          "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "NO",
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "MACOSX_DEPLOYMENT_TARGET": "11.0"
          },
          "link_settings": {
            "libraries": ["-framework Carbon"]
          }
        }]
      ]
    }
  ]
}
