package com.lutstra.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import org.junit.Test;

public class FlacArtistsTest {
    private static byte[] flac(String... comments) {
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        le(body, 3); body.writeBytes("lib".getBytes(StandardCharsets.UTF_8));
        le(body, comments.length);
        for (String c : comments) { byte[] b = c.getBytes(StandardCharsets.UTF_8); le(body, b.length); body.writeBytes(b); }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.writeBytes("fLaC".getBytes(StandardCharsets.US_ASCII));
        out.writeBytes(ByteBuffer.allocate(4).putInt(34).array()); out.writeBytes(new byte[34]); // STREAMINFO
        out.writeBytes(ByteBuffer.allocate(4).putInt(0x84000000 | body.size()).array()); // last, VORBIS_COMMENT
        out.writeBytes(body.toByteArray());
        return out.toByteArray();
    }

    private static void le(ByteArrayOutputStream out, int v) {
        out.writeBytes(ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(v).array());
    }

    private static String read(byte[] bytes) throws Exception { return FlacArtists.read(new ByteArrayInputStream(bytes)); }

    @Test
    public void joinsSeveralArtistsAsTheDesktopDoes() throws Exception {
        assertEquals("Wren Evans & itsnk", read(flac("TITLE=bé ơi từ từ", "ARTIST=Wren Evans", "artist=itsnk")));
        assertEquals("A, B & C", read(flac("ARTIST=A", "ARTIST=B", "ARTIST=C", "ARTIST=B")));
    }

    @Test
    public void leavesOneArtistAndOtherFilesToTheRetriever() throws Exception {
        assertNull(read(flac("ARTIST=Solo", "ALBUMARTIST=X")));
        assertNull(read("ID3\u0003junk".getBytes(StandardCharsets.US_ASCII)));
    }
}
