package com.lutstra.android;

import java.io.BufferedInputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Every ARTIST in a FLAC's Vorbis comment, joined as the desktop's music-metadata joins them ("A, B & C").
 * MediaMetadataRetriever returns only one of several ARTIST tags.
 */
final class FlacArtists {
    private FlacArtists() {}

    /** The joined artists, or null when the stream is not FLAC or has fewer than two ARTIST tags. */
    static String read(InputStream raw) throws IOException {
        DataInputStream in = new DataInputStream(new BufferedInputStream(raw));
        byte[] magic = new byte[4];
        in.readFully(magic);
        if (!"fLaC".equals(new String(magic, StandardCharsets.US_ASCII))) return null;
        boolean last = false;
        while (!last) {
            int header = in.readInt();
            last = header < 0;
            int type = (header >>> 24) & 0x7f, length = header & 0xffffff;
            if (type != 4) {
                for (int left = length; left > 0; ) {
                    int skipped = in.skipBytes(left);
                    if (skipped <= 0) return null;
                    left -= skipped;
                }
                continue;
            }
            byte[] block = new byte[length];
            in.readFully(block);
            ByteBuffer buf = ByteBuffer.wrap(block).order(ByteOrder.LITTLE_ENDIAN);
            buf.position(4 + buf.getInt());
            List<String> artists = new ArrayList<>();
            for (int count = buf.getInt(); count > 0; count--) {
                int size = buf.getInt();
                String comment = new String(block, buf.position(), size, StandardCharsets.UTF_8);
                buf.position(buf.position() + size);
                int eq = comment.indexOf('=');
                if (eq > 0 && comment.substring(0, eq).equalsIgnoreCase("ARTIST")) {
                    String value = comment.substring(eq + 1).trim();
                    if (!value.isEmpty() && !artists.contains(value)) artists.add(value);
                }
            }
            if (artists.size() < 2) return null;
            int end = artists.size() - 1;
            return String.join(", ", artists.subList(0, end)) + " & " + artists.get(end);
        }
        return null;
    }
}
