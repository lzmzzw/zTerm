try
  if !empty($ZTERM_USER_VIMINIT)
    execute $ZTERM_USER_VIMINIT
  else
    let g:zterm_mouse_win = has('win32') || has('win64')
    let g:zterm_mouse_rcs = g:zterm_mouse_win ? [$HOME . '/_vimrc', $HOME . '/.vimrc', $HOME . '/vimfiles/vimrc', $VIM . '/_vimrc'] : [$HOME . '/.vimrc', $HOME . '/_vimrc', $HOME . '/.vim/vimrc']
    let g:zterm_mouse_found = 0
    for g:zterm_mouse_rc in g:zterm_mouse_rcs
      let g:zterm_mouse_path = g:zterm_mouse_rc
      if filereadable(g:zterm_mouse_path)
        let $MYVIMRC = g:zterm_mouse_path
        execute 'source ' . fnameescape(g:zterm_mouse_path)
        let g:zterm_mouse_found = 1
        break
      endif
    endfor
    if !g:zterm_mouse_found && !empty($EXINIT)
      execute $EXINIT
      let g:zterm_mouse_found = 1
    endif
    if !g:zterm_mouse_found
      for g:zterm_mouse_rc in (g:zterm_mouse_win ? [$HOME . '/_exrc', $VIM . '/_exrc'] : [$HOME . '/.exrc'])
        let g:zterm_mouse_path = g:zterm_mouse_rc
        if filereadable(g:zterm_mouse_path)
          execute 'source ' . fnameescape(g:zterm_mouse_path)
          let g:zterm_mouse_found = 1
          break
        endif
      endfor
    endif
    if !g:zterm_mouse_found
      runtime defaults.vim
    endif
    unlet! g:zterm_mouse_win g:zterm_mouse_rcs g:zterm_mouse_found g:zterm_mouse_rc g:zterm_mouse_path
  endif
finally
  set mouse=a
  augroup ZTermMouse
    execute 'autocmd!'
    execute 'autocmd VimEnter * set mouse=a'
  augroup END
endtry
