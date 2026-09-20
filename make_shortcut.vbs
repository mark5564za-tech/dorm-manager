Set WshShell = CreateObject("WScript.Shell")
desktop = WshShell.SpecialFolders("Desktop")
Set shortcut = WshShell.CreateShortcut(desktop & "\Dorm Manager.lnk")
shortcut.TargetPath = "C:\Users\Asus\Documents\dorm-manager\เปิดระบบ.bat"
shortcut.WorkingDirectory = "C:\Users\Asus\Documents\dorm-manager"
shortcut.IconLocation = "C:\Windows\System32\shell32.dll,137"
shortcut.Description = "Dorm Manager"
shortcut.Save
