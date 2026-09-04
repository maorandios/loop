pub struct NativeCopy {
    pub brand: &'static str,
    pub tray_open: &'static str,
    pub tray_quit: &'static str,
    pub new_file_from_prefix: &'static str,
    pub file_returned_suffix: &'static str,
}

pub const HE: NativeCopy = NativeCopy {
    brand: "FileRelay",
    tray_open: "פתח את FileRelay",
    tray_quit: "יציאה",
    new_file_from_prefix: "קובץ חדש מ",
    file_returned_suffix: " החזירה את הקובץ",
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_copy_stays_hebrew() {
        assert_eq!(HE.tray_open, "פתח את FileRelay");
        assert_eq!(HE.tray_quit, "יציאה");
        assert_eq!(HE.brand, "FileRelay");
        assert_eq!(HE.new_file_from_prefix, "קובץ חדש מ");
    }
}
